"""Reproductions of the second September 2026 review against Postgres: retry
key races, ownership at the moment a write takes effect, dependency records and
reused embeddings at publication, fair waiting reconciliation and the running
limit. Each failed on the code it reviewed."""

from __future__ import annotations

import uuid
import asyncio
from typing import Any

import pytest
import psycopg

import dembrane.analysis.store as store_module
from tests.analysis.helpers import Recorder
from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import race, execute, new_project
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.contracts import (
    NewRun,
    Origin,
    RunMode,
    RunStatus,
    ScopeKind,
    Provenance,
    NewRevision,
    RevisionStatus,
    PublicationRejected,
)
from tests.analysis.fixture_recipes import WORDS, FixtureWorld

pytestmark = pytest.mark.integration

RECIPE = "fixture.findings"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"


async def _scope(store: SqlAnalysisStore, project: str, recipe: str = RECIPE, scope_key: str = "project") -> str:
    return (await store.ensure_scope(project_id=project, kind=ScopeKind.PRODUCER, owner_id=recipe, scope_key=scope_key)).id


def _new(project: str, scope_id: str, key: str, **overrides: Any) -> NewRun:
    manifest = overrides.pop("input_manifest", {"revisionIds": [], "dependencies": {}})
    base: dict[str, Any] = dict(
        project_id=project,
        scope_id=scope_id,
        recipe_id=RECIPE,
        recipe_version="1",
        definition={"id": RECIPE, "version": "1", "steps": []},
        mode=RunMode.REFRESH,
        idempotency_key=key,
        request_fingerprint=content_hash(key),
        status=RunStatus.QUEUED,
        epoch=0,
        input_manifest=manifest,
        input_fingerprint=content_hash(manifest) if manifest is not None else None,
    )
    base.update(overrides)
    return NewRun(**base)


def _manifest(run: Any, **inputs: Any) -> dict[str, Any]:
    pinned = run.input_manifest or {}
    return {
        "objects": [],
        "relations": [],
        "inputs": {
            "fingerprint": run.input_fingerprint,
            "revisionIds": list(pinned.get("revisionIds") or []),
            "dependencies": dict(pinned.get("dependencies") or {}),
            **inputs,
        },
    }


async def _claimed(store: SqlAnalysisStore, run_id: str) -> tuple[Any, str]:
    lease = uuid.uuid4().hex
    claim = await store.claim_run(run_id, lease, max_running=None)
    assert claim.outcome == "claimed" and claim.run is not None
    return claim.run, lease


# ── B4 ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b4_two_retries_racing_with_one_key_return_one_run(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    world.sources[project] = {C1: ["Trams are better."], C2: ["Bikes are healthy."]}
    world.fail_conversations = {C1, C2}
    failed = []
    for cid in (C1, C2):
        outcome = await request_run(RunRequest(project, WORDS, f"conversation:{cid}", idempotency_key=cid), store=store, deps=rec.deps())
        assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "failed"
        failed.append(outcome.run.id)

    def retry(cid: str) -> Any:
        async def ask(racer: SqlAnalysisStore) -> Any:
            return await request_run(
                RunRequest(project, WORDS, f"conversation:{cid}", mode="retry", idempotency_key="one-key"), store=racer, deps=rec.deps()
            )

        return ask

    left, right = await race(pg_dsn, "SELECT 1 FROM analysis_run WHERE id = ANY(%s::uuid[]) FOR UPDATE", (failed,), retry(C1), retry(C2))
    assert not isinstance(left, BaseException) and not isinstance(right, BaseException), (left, right)
    assert left.run.id == right.run.id
    statuses = await execute(pg_dsn, "SELECT status FROM analysis_run WHERE id = ANY(%s::uuid[]) ORDER BY status", (failed,))
    assert statuses == [("failed",), ("queued",)]


# ── B6 ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b6_a_lease_that_lapses_while_waiting_for_the_scope_cannot_publish(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "late"))
    run, lease = await _claimed(store, run.id)
    await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = clock_timestamp() + interval '1 second' WHERE id = %s", (run.id,))
    async with await psycopg.AsyncConnection.connect(pg_dsn) as holder:
        await holder.execute("SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (scope_id,))
        publishing = asyncio.create_task(store.publish_run(run.id, lease, manifest=_manifest(run), checks=[], metrics={}))
        await asyncio.sleep(1.6)
        await holder.commit()
    assert (await publishing).outcome == "inactive"


@pytest.mark.asyncio
async def test_b6_a_checkpoint_waits_for_a_writer_transfer_and_then_refuses(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "fenced"))
    run, lease = await _claimed(store, run.id)
    async with await psycopg.AsyncConnection.connect(pg_dsn) as holder:
        await holder.execute("UPDATE analysis_scope SET writer_fence = writer_fence + 1 WHERE id = %s", (scope_id,))
        beat = asyncio.create_task(store.heartbeat_run(run.id, lease, {"stage": "late"}))
        await asyncio.sleep(0.3)
        await holder.commit()
    assert await beat is False


@pytest.mark.asyncio
async def test_b6_finishing_a_run_requires_ownership_except_for_superseded_settlement(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)

    expired, _ = await store.create_run(_new(project, scope_id, "expired"))
    expired, expired_lease = await _claimed(store, expired.id)
    await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = %s", (expired.id,))
    assert await store.finish_run(expired.id, expired_lease, status=RunStatus.FAILED, error="late") is False

    older, _ = await store.create_run(_new(project, scope_id, "older"))
    newer, _ = await store.create_run(_new(project, scope_id, "newer"))
    older, older_lease = await _claimed(store, older.id)
    newer, newer_lease = await _claimed(store, newer.id)
    assert (await store.publish_run(newer.id, newer_lease, manifest=_manifest(newer), checks=[], metrics={})).outcome == "ready"
    assert await store.finish_run(older.id, older_lease, status=RunStatus.NEEDS_REVIEW) is False
    assert await store.finish_run(older.id, older_lease, status=RunStatus.SUPERSEDED) is True

    other_scope = await _scope(store, project, scope_key="report:fence")
    fenced, _ = await store.create_run(_new(project, other_scope, "fenced"))
    fenced, fenced_lease = await _claimed(store, fenced.id)
    await execute(pg_dsn, "UPDATE analysis_scope SET writer_fence = writer_fence + 1 WHERE id = %s", (other_scope,))
    assert await store.finish_run(fenced.id, fenced_lease, status=RunStatus.FAILED, error="late") is False


# ── B7 ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b7_publication_compares_dependency_records_and_checks_reused_embeddings(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    pinned = {"revisionIds": [], "dependencies": {"arguments": {"recipeId": "fixture.words", "runId": str(uuid.uuid4()), "manifestHash": "a" * 64}}}
    run, _ = await store.create_run(_new(project, scope_id, "deps", input_manifest=pinned))
    run, lease = await _claimed(store, run.id)
    forged = _manifest(run, dependencies={"arguments": {"recipeId": "fixture.words", "runId": str(uuid.uuid4()), "manifestHash": "b" * 64}})
    with pytest.raises(PublicationRejected, match="dependencies"):
        await store.publish_run(run.id, lease, manifest=forged, checks=[], metrics={})

    record = await store.ensure_object(project_id=project, type="argument", lineage_key="imported:x", scope_id=scope_id)
    payload = {"statement": "Imported.", "epistemicKind": "argument"}
    head = await store.append_revision(
        NewRevision(
            project_id=project,
            object_id=record.id,
            type="argument",
            schema_version=1,
            origin=Origin.IMPORTED,
            payload=payload,
            attributes={"epistemicKind": "argument"},
            provenance=Provenance(run_id=None, origin=Origin.IMPORTED),
            content_hash="c" * 64,
            status=RevisionStatus.PUBLISHED,
            embedding_refs={"embeddingId": str(uuid.uuid4()), "configKey": "missing"},
        ),
        expected_revision_id=None,
    )
    reusing = {**_manifest(run), "objects": [{"objectId": record.id, "revisionId": head.id, "type": "argument"}]}
    with pytest.raises(PublicationRejected, match="embedding"):
        await store.publish_run(run.id, lease, manifest=reusing, checks=[], metrics={})


# ── B9 ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b9_unsettleable_waiters_do_not_starve_a_runnable_one(pg_dsn: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "WAKE_BATCH", 2)
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    blocked_scope = await _scope(store, project, scope_key="report:blocked")
    ready_scope = await _scope(store, project, scope_key="report:ready")
    blocked, _ = await store.create_run(_new(project, blocked_scope, "blocked"))
    blocked, blocked_lease = await _claimed(store, blocked.id)
    assert await store.finish_run(blocked.id, blocked_lease, status=RunStatus.NEEDS_REVIEW)
    parent = await _scope(store, project, "fixture.parent")

    def waiter(key: str, dependency: str) -> NewRun:
        return _new(project, parent, key, recipe_id="fixture.parent", status=RunStatus.WAITING_FOR_INPUTS, depends_on=(dependency,), input_manifest=None)

    for index in range(2):
        await store.create_run(waiter(f"stuck-{index}", blocked.id))
    done, _ = await store.create_run(_new(project, ready_scope, "done"))
    done, done_lease = await _claimed(store, done.id)
    assert (await store.publish_run(done.id, done_lease, manifest=_manifest(done), checks=[], metrics={})).outcome == "ready"
    runnable, _ = await store.create_run(waiter("runnable", done.id))

    result = await store.wake_waiting_runs(project)
    assert [r.id for r in result.woken] == [runnable.id]


# ── B11 ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b11_concurrent_claims_respect_the_running_limit(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    runs = []
    for index in range(4):
        scope_id = await _scope(store, project, "fixture.limited", scope_key=f"report:{index}")
        run, _ = await store.create_run(_new(project, scope_id, f"limited-{index}", recipe_id="fixture.limited"))
        runs.append(run)
    outcomes = await asyncio.gather(
        *(SqlAnalysisStore(dsn=pg_dsn).claim_run(run.id, uuid.uuid4().hex, max_running=1) for run in runs)
    )
    assert sum(1 for o in outcomes if o.outcome == "claimed") == 1


# ── B3 ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b3_a_superseded_dependency_is_not_replaced_by_an_incompatible_computation(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    dep_scope = await _scope(store, project)
    d1, _ = await store.create_run(_new(project, dep_scope, "d1", context={"voice": "a"}))
    d2, _ = await store.create_run(_new(project, dep_scope, "d2", context={"voice": "b"}))
    d1, l1 = await _claimed(store, d1.id)
    d2, l2 = await _claimed(store, d2.id)
    assert (await store.publish_run(d2.id, l2, manifest=_manifest(d2), checks=[], metrics={})).outcome == "ready"
    assert (await store.publish_run(d1.id, l1, manifest=_manifest(d1), checks=[], metrics={})).outcome == "superseded"
    parent = await _scope(store, project, "fixture.parent")
    waiter, _ = await store.create_run(
        _new(project, parent, "w", recipe_id="fixture.parent", status=RunStatus.WAITING_FOR_INPUTS, depends_on=(d1.id,), input_manifest=None)
    )
    await store.wake_waiting_runs(project)
    assert (await store.get_run(waiter.id)).status == RunStatus.FAILED  # type: ignore[union-attr]
