"""Reproductions of the September 15th 2026 review findings on the SQL store.

Each test failed against the store as first written (1: the ownership subquery
had three columns; 2: a deduplicated key created a second run later; 3: an
older run published over a later reuse request; 4: a superseded dependency
woke its parent; 5: a completed step was rewritten). They stay as regression
tests, next to the checks for findings 6 to 10.
"""

from __future__ import annotations

import uuid
import asyncio
from typing import Any

import pytest

from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import execute, new_project
from dembrane.analysis.contracts import (
    NewRun,
    Origin,
    RunMode,
    StepKind,
    RunStatus,
    ScopeKind,
    StepWrite,
    Provenance,
    StepStatus,
    NewRevision,
    NewSnapshot,
    StepConflict,
    RevisionStatus,
    ReferenceViolation,
    PublicationRejected,
)

pytestmark = pytest.mark.integration

RECIPE = "fixture.findings"


async def _scope(store: SqlAnalysisStore, project: str, recipe: str = RECIPE) -> str:
    scope = await store.ensure_scope(project_id=project, kind=ScopeKind.PRODUCER, owner_id=recipe, scope_key="project")
    return scope.id


def _new(project: str, scope_id: str, key: str, fingerprint: str, **overrides: Any) -> NewRun:
    base: dict[str, Any] = dict(
        project_id=project,
        scope_id=scope_id,
        recipe_id=RECIPE,
        recipe_version="1",
        definition={"id": RECIPE, "version": "1", "steps": []},
        mode=RunMode.REFRESH,
        idempotency_key=key,
        request_fingerprint=fingerprint,
        status=RunStatus.QUEUED,
        epoch=0,
        input_manifest={"revisionIds": []},
        input_fingerprint=None,
    )
    base.update(overrides)
    if base["input_manifest"] is not None and base["input_fingerprint"] is None:
        from dembrane.analysis.hashing import content_hash

        base["input_fingerprint"] = content_hash(base["input_manifest"])
    return NewRun(**base)


def _manifest(run: Any) -> dict[str, Any]:
    return {
        "objects": [],
        "relations": [],
        "inputs": {"fingerprint": run.input_fingerprint, "revisionIds": list((run.input_manifest or {}).get("revisionIds") or [])},
    }


async def _claimed(store: SqlAnalysisStore, run_id: str) -> tuple[Any, str]:
    lease = uuid.uuid4().hex
    claim = await store.claim_run(run_id, lease, max_running=None)
    assert claim.outcome == "claimed" and claim.run is not None
    return claim.run, lease


@pytest.mark.asyncio
async def test_finding_1_heartbeat_and_pin_inputs_work_for_the_lease_holder(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "k1", "a" * 64, input_manifest=None))
    run, lease = await _claimed(store, run.id)

    assert await store.heartbeat_run(run.id, lease, {"stage": "extracting"}) is True
    manifest = {"revisionIds": []}
    from dembrane.analysis.hashing import content_hash

    assert await store.pin_inputs(run.id, lease, input_manifest=manifest, input_fingerprint=content_hash(manifest))
    # Write-once: the same manifest again is fine, another one is refused.
    assert await store.pin_inputs(run.id, lease, input_manifest=manifest, input_fingerprint=content_hash(manifest))
    other = {"revisionIds": [str(uuid.uuid4())]}
    with pytest.raises(Exception, match="already pinned"):
        await store.pin_inputs(run.id, lease, input_manifest=other, input_fingerprint=content_hash(other))


@pytest.mark.asyncio
async def test_finding_2_a_deduplicated_key_keeps_returning_its_run(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    first, created = await store.create_run(_new(project, scope_id, "k1", "b" * 64))
    assert created
    joined, created = await store.create_run(_new(project, scope_id, "k2", "b" * 64))
    assert not created and joined.id == first.id

    _run, lease = await _claimed(store, first.id)
    assert await store.finish_run(first.id, lease, status=RunStatus.FAILED, error="x")

    again, created = await store.create_run(_new(project, scope_id, "k2", "b" * 64))
    assert not created and again.id == first.id
    assert (await store.run_by_idempotency_key(project, "k2")).id == first.id  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_finding_3_a_ready_reuse_request_fences_an_older_running_run(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    r1, _ = await store.create_run(_new(project, scope_id, "r1", "c" * 64))
    r1, lease1 = await _claimed(store, r1.id)
    assert (await store.publish_run(r1.id, lease1, manifest=_manifest(r1), checks=[], metrics={})).outcome == "ready"

    r2, _ = await store.create_run(_new(project, scope_id, "r2", "d" * 64, mode=RunMode.REGENERATE, epoch=None))
    r2, lease2 = await _claimed(store, r2.id)

    ready_r1 = await store.get_run(r1.id)
    assert ready_r1 is not None
    r3, created = await store.create_run(
        _new(
            project,
            scope_id,
            "r3",
            "e" * 64,
            status=RunStatus.READY,
            reused_run_id=r1.id,
            output_manifest=ready_r1.output_manifest,
        )
    )
    assert created and r3.request_order > r2.request_order
    scope = await store.get_scope(scope_id)
    assert scope is not None and scope.current_run_id == r3.id

    outcome = await store.publish_run(r2.id, lease2, manifest=_manifest(r2), checks=[], metrics={})
    assert outcome.outcome == "superseded"

    # Reusing a run that is no longer current is refused.
    from dembrane.analysis.contracts import ReuseOutdated

    with pytest.raises(ReuseOutdated):
        await store.create_run(
            _new(project, scope_id, "r4", "f" * 64, status=RunStatus.READY, reused_run_id=r1.id, output_manifest=ready_r1.output_manifest)
        )


@pytest.mark.asyncio
async def test_finding_4_a_superseded_dependency_does_not_wake_its_parent(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    dep_scope = await _scope(store, project)
    d1, _ = await store.create_run(_new(project, dep_scope, "d1", "1" * 64))
    d2, _ = await store.create_run(_new(project, dep_scope, "d2", "2" * 64))
    d1, l1 = await _claimed(store, d1.id)
    d2, l2 = await _claimed(store, d2.id)
    assert (await store.publish_run(d2.id, l2, manifest=_manifest(d2), checks=[], metrics={})).outcome == "ready"
    assert (await store.publish_run(d1.id, l1, manifest=_manifest(d1), checks=[], metrics={})).outcome == "superseded"

    parent_scope = await store.ensure_scope(
        project_id=project, kind=ScopeKind.PRODUCER, owner_id="fixture.parent", scope_key="project"
    )
    parent, _ = await store.create_run(
        _new(
            project,
            parent_scope.id,
            "p1",
            "3" * 64,
            recipe_id="fixture.parent",
            status=RunStatus.WAITING_FOR_INPUTS,
            depends_on=(d1.id,),
            input_manifest=None,
        )
    )
    result = await store.wake_waiting_runs(project)
    after = await store.get_run(parent.id)
    assert after is not None and after.status == RunStatus.QUEUED
    # Re-resolved explicitly to the newer ready output, and recorded.
    assert after.depends_on == [d2.id] and after.progress["reresolved"] == {d1.id: d2.id}
    assert [r.id for r in result.woken] == [parent.id]

    # A superseded dependency with no newer ready output fails its waiter.
    lonely_scope = await _scope(store, project, "fixture.lonely")
    lonely, _ = await store.create_run(_new(project, lonely_scope, "l1", "4" * 64, recipe_id="fixture.lonely"))
    await execute(pg_dsn, "UPDATE analysis_run SET status = 'superseded' WHERE id = %s", (lonely.id,))
    waiter, _ = await store.create_run(
        _new(project, parent_scope.id, "p2", "5" * 64, recipe_id="fixture.parent", status=RunStatus.WAITING_FOR_INPUTS, depends_on=(lonely.id,), input_manifest=None)
    )
    await store.wake_waiting_runs(project)
    assert (await store.get_run(waiter.id)).status == RunStatus.FAILED  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_finding_5_a_completed_step_artifact_is_never_rewritten(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "s1", "4" * 64))
    run, lease = await _claimed(store, run.id)
    write = StepWrite(
        step_key="extract",
        step_version="1",
        kind=StepKind.MODEL,
        cache_key="k" * 64,
        status=StepStatus.COMPLETED,
        output={"items": ["first"]},
    )
    saved = await store.checkpoint_step(run.id, lease, write)
    assert saved is not None
    assert (await store.checkpoint_step(run.id, lease, write)).id == saved.id  # type: ignore[union-attr]

    with pytest.raises(StepConflict):
        await store.checkpoint_step(
            run.id, lease, StepWrite(**{**write.__dict__, "cache_key": "j" * 64, "output": {"items": ["second"]}})
        )
    rows = await execute(pg_dsn, "SELECT output::text, cache_key FROM analysis_step WHERE id = %s", (saved.id,))
    assert rows == [('{"items": ["first"]}', "k" * 64)]
    # The table refuses it too.
    with pytest.raises(Exception, match="completed analysis_step is immutable"):
        await execute(pg_dsn, "UPDATE analysis_step SET output = '{}' WHERE id = %s", (saved.id,))


# ── findings 6 to 10 ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_finding_6_a_checkpoint_serialises_with_a_newer_publication(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    old, _ = await store.create_run(_new(project, scope_id, "o", "6" * 64))
    new, _ = await store.create_run(_new(project, scope_id, "n", "7" * 64))
    old, old_lease = await _claimed(store, old.id)
    new, new_lease = await _claimed(store, new.id)

    # The newer run's publication holds the scope; the older run's checkpoint
    # waits for it and then sees the newer ready request.
    from psycopg import AsyncConnection

    async with await AsyncConnection.connect(pg_dsn) as holder:
        await holder.execute("SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (scope_id,))
        checkpoint = asyncio.create_task(store.heartbeat_run(old.id, old_lease, {"stage": "late"}))
        await asyncio.sleep(0.3)
        assert not checkpoint.done()
        await holder.execute(
            "UPDATE analysis_run SET status = 'ready', output_manifest = '{}' WHERE id = %s", (new.id,)
        )
        await holder.execute(
            "UPDATE analysis_scope SET current_run_id = %s, current_request_order = %s WHERE id = %s",
            (new.id, new.request_order, scope_id),
        )
        await holder.commit()
    assert await checkpoint is False


@pytest.mark.asyncio
async def test_finding_6_a_lease_past_its_deadline_cannot_checkpoint_or_publish(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn, lease_seconds=1)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "e", "8" * 64))
    run, lease = await _claimed(store, run.id)
    assert await store.heartbeat_run(run.id, lease, {"stage": "working"})
    await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (run.id,))

    assert await store.heartbeat_run(run.id, lease, {"stage": "late"}) is False
    assert (await store.publish_run(run.id, lease, manifest=_manifest(run), checks=[], metrics={})).outcome == "inactive"
    # Nobody reclaimed it; another worker may now.
    assert (await store.claim_run(run.id, uuid.uuid4().hex, max_running=None)).outcome == "claimed"


@pytest.mark.asyncio
async def test_finding_7_publication_checks_pinned_inputs_provenance_and_embeddings(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    scope_id = await _scope(store, project)
    run, _ = await store.create_run(_new(project, scope_id, "p", "9" * 64))
    run, lease = await _claimed(store, run.id)
    record = await store.ensure_object(project_id=project, type="argument", lineage_key="x", scope_id=scope_id)
    stray = str(uuid.uuid4())
    staged = await store.stage_revision(
        run.id,
        lease,
        NewRevision(
            project_id=project,
            object_id=record.id,
            type="argument",
            schema_version=1,
            origin=Origin.GENERATED,
            payload={"statement": "S", "epistemicKind": "argument"},
            attributes={"epistemicKind": "argument"},
            provenance=Provenance(run_id=run.id, origin=Origin.GENERATED, recipe_id=RECIPE, recipe_version="1", input_revision_ids=(stray,)),
            content_hash="h" * 64,
            status=RevisionStatus.STAGED,
            run_id=run.id,
            embedding_refs={"embeddingId": str(uuid.uuid4()), "configKey": "c"},
        ),
    )
    assert staged is not None
    manifest = {
        "objects": [{"objectId": record.id, "revisionId": staged.id, "type": "argument"}],
        "relations": [],
        "inputs": {"fingerprint": run.input_fingerprint, "revisionIds": [stray]},
    }
    with pytest.raises(PublicationRejected) as rejected:
        await store.publish_run(run.id, lease, manifest=manifest, checks=[], metrics={})
    reasons = " | ".join(rejected.value.reasons)
    assert "not the run's pinned inputs" in reasons
    assert "not pinned inputs" in reasons
    assert "embedding that is not this project's" in reasons
    # A failed check blocks publication too.
    clean = {**manifest, "objects": [], "inputs": {"fingerprint": run.input_fingerprint, "revisionIds": []}}
    with pytest.raises(PublicationRejected, match="check grounded is failed"):
        await store.publish_run(run.id, lease, manifest=clean, checks=[{"check": "grounded", "status": "failed"}], metrics={})


@pytest.mark.asyncio
async def test_finding_8_and_10_snapshot_assessment_tuples_and_immutability(pg_dsn: str) -> None:
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    view = await store.ensure_scope(project_id=project, kind=ScopeKind.VIEW, owner_id="map", scope_key="project")
    with pytest.raises(PublicationRejected, match="not that assessment of that revision"):
        await store.publish_snapshot(
            NewSnapshot(
                project_id=project,
                scope_id=view.id,
                view_id="map",
                manifest={
                    "objects": [],
                    "relations": [],
                    "assessments": [
                        {"relationId": str(uuid.uuid4()), "revisionId": str(uuid.uuid4()), "targetRevisionId": str(uuid.uuid4())}
                    ],
                },
                content_hash="s" * 64,
            ),
            expected_previous_id=None,
        )
    first = await store.publish_snapshot(
        NewSnapshot(project_id=project, scope_id=view.id, view_id="map", manifest={"objects": []}, content_hash="a" * 64),
        expected_previous_id=None,
    )
    second = await store.publish_snapshot(
        NewSnapshot(project_id=project, scope_id=view.id, view_id="map", manifest={"objects": []}, content_hash="b" * 64, settings={"colorBy": "type"}),
        expected_previous_id=first.id,
    )
    from psycopg.errors import CheckViolation

    with pytest.raises((CheckViolation, ReferenceViolation), match="immutable"):
        await execute(
            pg_dsn,
            "UPDATE analysis_snapshot SET parent_snapshot_id = NULL, settings = '{\"colorBy\": \"valence\"}' WHERE id = %s",
            (second.id,),
        )
    # Only the parent reference may become NULL.
    await execute(pg_dsn, "UPDATE analysis_snapshot SET parent_snapshot_id = NULL WHERE id = %s", (second.id,))


@pytest.mark.asyncio
async def test_finding_9_an_authored_edit_commits_with_its_outbox_event(pg_dsn: str) -> None:
    from dembrane.analysis.revisions import RevisionService

    failing = SqlAnalysisStore(dsn=pg_dsn, fault=lambda point: (_ for _ in ()).throw(RuntimeError(point)) if point == "append:outbox" else None)
    store = SqlAnalysisStore(dsn=pg_dsn)
    project = await new_project(pg_dsn)
    created = await RevisionService(store).create_authored(
        project_id=project, type_id="argument", payload={"statement": "Trams.", "epistemicKind": "argument"}, actor_id="u1"
    )
    events = await execute(pg_dsn, "SELECT event_type, payload::jsonb->>'revisionId' FROM analysis_outbox WHERE project_id = %s", (project,))
    assert events == [("revision_published", created.id)]

    with pytest.raises(RuntimeError, match="append:outbox"):
        await RevisionService(failing).author_edit(
            project_id=project,
            object_id=created.object_id,
            expected_revision_id=created.id,
            payload={"statement": "Trams, often.", "epistemicKind": "argument"},
            actor_id="u1",
        )
    record = await store.get_object(created.object_id)
    assert record is not None and record.current_revision_id == created.id
    assert len(await execute(pg_dsn, "SELECT 1 FROM analysis_outbox WHERE project_id = %s", (project,))) == 1
