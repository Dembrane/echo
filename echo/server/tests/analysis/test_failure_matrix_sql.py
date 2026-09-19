"""The failure and reconstruction table against Postgres.

The in-memory matrix in `test_failure_matrix.py` covers every row. The rows
whose guarantee is the database's own (one short transaction, request order,
the lease, the outbox claim, the expected head) are repeated here against the
throwaway schema from `conftest.pg_dsn`, with the real producers and scripted
models. Two of them meet at a lock through `conftest.race`, so the
compare-and-set is under real contention rather than in one event loop.
"""

from __future__ import annotations

import asyncio
from typing import Any
from dataclasses import replace

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import race, execute, new_project
from dembrane.analysis.outbox import dispatch_events
from dembrane.analysis.executor import RunRequest, ExecutorDeps, run_worker, request_run
from dembrane.analysis.contracts import Run, RunStatus, ObjectRevision, RevisionConflict
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import ProducerRef, SnapshotRequest, build_manifest
from tests.analysis.producer_fakes import (
    C3,
    PROJECT,
    RECORDINGS,
    MERGED_RECORD,
    ProducerWorld,
    item,
    merge_all,
)
from dembrane.analysis.recipes.services import SERVICES_KEY, ProducerServices

pytestmark = pytest.mark.integration

CHAIN = ("arguments", "deduplicated_arguments", "tensions")


def _services(world: ProducerWorld) -> ProducerServices:
    """The world's scripted services, answering for whichever project the
    schema minted. The world keys its transcripts by its own project id, and
    this file makes a fresh project per test."""
    base = world.services()

    async def transcripts(_project_id: str) -> list[Any]:
        return list(world.transcripts)

    return replace(base, transcripts=transcripts)


def _deps(world: ProducerWorld, rec: Recorder) -> ExecutorDeps:
    deps = rec.deps()
    deps.services = {SERVICES_KEY: _services(world)}
    return deps


def _request(project: str, recipe: str, key: str, **kwargs: Any) -> RunRequest:
    parameters = kwargs.pop("parameters", None)
    if parameters is None:
        parameters = {"input_set": "deduplicated_arguments"} if recipe == "tensions" else {}
    return RunRequest(project, recipe, "project", parameters=parameters, idempotency_key=key, **kwargs)


async def _current(store: SqlAnalysisStore, project: str, recipe: str) -> Run:
    scope = await store.find_scope(project_id=project, kind="producer", owner_id=recipe, scope_key="project")  # type: ignore[arg-type]
    assert scope is not None and scope.current_run_id is not None
    run = await store.get_run(scope.current_run_id)
    assert run is not None
    return run


async def _chain(store: SqlAnalysisStore, project: str, world: ProducerWorld, rec: Recorder) -> dict[str, Run]:
    world.verifier = merge_all(MERGED_RECORD)
    deps = _deps(world, rec)
    outcome = await request_run(_request(project, "tensions", "chain"), store=store, deps=deps)
    arguments, dedup = outcome.dependencies
    for run_id in (arguments.id, dedup.id, outcome.run.id):
        assert await run_worker(run_id, store=store, deps=deps) == "ready"
        await dispatch_events(store=store, deps=rec.outbox_deps())
    return {recipe: await _current(store, project, recipe) for recipe in CHAIN}


def _snapshot_request(project: str) -> SnapshotRequest:
    return SnapshotRequest(
        project_id=project,
        view_id="map",
        scope_key="project",
        producers=tuple(ProducerRef(recipe_id=recipe, scope_key="project") for recipe in CHAIN),
    )


def _changed_third_conversation(world: ProducerWorld) -> None:
    world.set_text(
        C3,
        "Cas: Buses are cheaper to run than trams at night.\n"
        "Cas: Keep the recordings, the notes never capture what people meant.\n"
        "Cas: Honestly, just keep the recordings.",
        [
            item("Night buses are cheaper to run than night trams.", "Buses are cheaper to run than trams at night"),
            item(RECORDINGS, "Keep the recordings, the notes never capture what people meant"),
        ],
    )


async def _count(dsn: str, table: str, project: str) -> int:
    return int((await execute(dsn, f"SELECT count(*) FROM {table} WHERE project_id = %s", (project,)))[0][0])


# ── row 1: repeat Refresh with unchanged inputs ─────────────────────────


@pytest.mark.asyncio
async def test_row_repeat_refresh_reuses_the_ready_output_and_calls_no_model(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    runs = await _chain(store, project, world, rec)
    calls, embeds = world.model_calls(), len(world.embed_calls)

    for recipe in CHAIN:
        outcome = await request_run(
            _request(project, recipe, f"again-{recipe}"), store=store, deps=_deps(world, rec)
        )
        assert outcome.outcome == "reused", recipe
        assert outcome.run.reused_run_id == runs[recipe].id
        assert outcome.run.output_manifest == runs[recipe].output_manifest

    assert world.model_calls() == calls and len(world.embed_calls) == embeds
    # Reuse writes a run row and no new revision.
    revisions = await _count(pg_dsn, "analysis_object_revision", project)
    assert revisions == len({o["revisionId"] for r in runs.values() for o in r.output_manifest["objects"]})  # type: ignore[index]


# ── row 3: crash after saved work, retry under a new lease ──────────────


@pytest.mark.asyncio
async def test_row_retry_resumes_saved_steps_and_the_former_lease_cannot_publish(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    deps = _deps(world, rec)
    world.fail_extract = {C3}

    outcome = await request_run(_request(project, "arguments", "a1"), store=store, deps=deps)
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "failed"
    failed = await store.get_run(outcome.run.id)
    assert failed is not None and failed.status == RunStatus.FAILED and failed.lease
    old_lease = failed.lease
    completed = await execute(
        pg_dsn, "SELECT count(*) FROM analysis_step WHERE run_id = %s AND status = 'completed'", (outcome.run.id,)
    )
    assert completed[0][0] >= 1

    world.fail_extract = set()
    retry = await request_run(_request(project, "arguments", "r1", mode="retry"), store=store, deps=deps)
    assert retry.outcome == "requeued" and retry.run.id == outcome.run.id
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "ready"

    resumed = await store.get_run(outcome.run.id)
    assert resumed is not None and resumed.attempt == 2 and resumed.lease != old_lease
    assert resumed.metrics["stepsResumed"] >= 1
    # The crashed worker's lease is no longer the run's, in the database.
    stale = await store.publish_run(outcome.run.id, old_lease, manifest={}, checks=[], metrics={})
    assert stale.outcome == "inactive"
    assert await store.heartbeat_run(outcome.run.id, old_lease, {"stage": "late"}) is False


# ── row 4: crash during publication ─────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("point", ["publish:locked", "publish:validated", "publish:heads", "publish:outbox"])
async def test_row_a_crash_during_publication_rolls_back_and_keeps_the_ready_output(pg_dsn: str, point: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    runs = await _chain(store, project, world, rec)
    heads = await execute(
        pg_dsn, "SELECT id, current_revision_id FROM analysis_object WHERE project_id = %s ORDER BY id", (project,)
    )
    events = await _count(pg_dsn, "analysis_outbox", project)
    before = await build_manifest(_snapshot_request(project), store=store)
    _changed_third_conversation(world)

    def crash(at: str) -> None:
        if at == point:
            raise RuntimeError(f"crashed at {at}")

    crashing = SqlAnalysisStore(dsn=pg_dsn, fault=crash)
    broken = await request_run(_request(project, "arguments", "a2"), store=store, deps=_deps(world, rec))
    assert await run_worker(broken.run.id, store=crashing, deps=_deps(world, rec)) == "failed"

    scope = await store.get_scope(runs["arguments"].scope_id)
    assert scope is not None and scope.current_run_id == runs["arguments"].id
    assert await execute(
        pg_dsn, "SELECT id, current_revision_id FROM analysis_object WHERE project_id = %s ORDER BY id", (project,)
    ) == heads
    assert await _count(pg_dsn, "analysis_outbox", project) == events
    statuses = await execute(
        pg_dsn, "SELECT DISTINCT status FROM analysis_object_revision WHERE run_id = %s", (broken.run.id,)
    )
    assert statuses == [("staged",)]
    # The previous ready output still assembles.
    after = await build_manifest(_snapshot_request(project), store=store)
    assert after["objects"] == before["objects"] and after["relations"] == before["relations"]


# ── row 5: crash after commit, before notification ──────────────────────


@pytest.mark.asyncio
async def test_row_a_failed_dispatch_is_retried_and_a_duplicate_delivers_once(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    deps = _deps(world, rec)
    outcome = await request_run(_request(project, "arguments", "a1"), store=store, deps=deps)
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "ready"
    ((event_id,),) = await execute(pg_dsn, "SELECT id::text FROM analysis_outbox WHERE run_id = %s", (outcome.run.id,))

    rec.publish_error = RuntimeError("redis is down")
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id)).retried == 1
    ((status, attempts),) = await execute(
        pg_dsn, "SELECT status, attempts FROM analysis_outbox WHERE id = %s", (event_id,)
    )
    assert (status, attempts) == ("pending", 1)
    rec.publish_error = None
    await execute(pg_dsn, "UPDATE analysis_outbox SET next_attempt_at = now() WHERE id = %s", (event_id,))

    calls, runs_before = world.model_calls(), await _count(pg_dsn, "analysis_run", project)
    reports = await asyncio.gather(
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id),
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id),
    )
    assert sum(r.claimed for r in reports) == 1 and sum(r.delivered for r in reports) == 1
    ((final,),) = await execute(pg_dsn, "SELECT status FROM analysis_outbox WHERE id = %s", (event_id,))
    assert final == "delivered"
    # A duplicate dispatch reran nothing and published nothing twice.
    assert world.model_calls() == calls
    assert await _count(pg_dsn, "analysis_run", project) == runs_before
    assert await _count(pg_dsn, "analysis_outbox", project) == 1


# ── row 6: a dependency changes under a completed consumer ──────────────


@pytest.mark.asyncio
async def test_row_a_changed_dependency_leaves_tensions_pinned_and_marks_them_stale(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    runs = await _chain(store, project, world, rec)
    tension_manifest = dict(runs["tensions"].output_manifest or {})
    supports = [r for r in tension_manifest["relations"] if r["type"].startswith("supports_pole")]
    assert supports
    judged = len(world.judge_calls)

    _changed_third_conversation(world)
    deps = _deps(world, rec)
    for recipe, key in (("arguments", "a2"), ("deduplicated_arguments", "d2")):
        refreshed = await request_run(_request(project, recipe, key), store=store, deps=deps)
        assert await run_worker(refreshed.run.id, store=store, deps=deps) == "ready"
        await dispatch_events(store=store, deps=rec.outbox_deps())

    assert (await _current(store, project, "tensions")).output_manifest == tension_manifest
    assert len(world.judge_calls) == judged
    stale = (await build_manifest(_snapshot_request(project), store=store))["stale"]
    assert ("output", "tensions") in {(s["kind"], s.get("recipeId")) for s in stale}

    # Every support edge still names the revision it was established against.
    for relation in supports:
        ((stored,),) = await execute(
            pg_dsn, "SELECT from_revision_id::text FROM analysis_relation WHERE id = %s", (relation["relationId"],)
        )
        assert stored == relation["from"]
    moved = await execute(
        pg_dsn,
        """SELECT count(*) FROM analysis_object o
           JOIN analysis_object_revision r ON r.object_id = o.id
           WHERE r.id = ANY(%s::uuid[]) AND o.current_revision_id <> r.id""",
        ([r["from"] for r in supports],),
    )
    assert moved[0][0] >= 1


# ── row 7: two publications, or an edit race, for one scope ─────────────


@pytest.mark.asyncio
async def test_row_request_order_supersedes_an_older_run_publishing_later(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    await _chain(store, project, world, rec)
    deps = _deps(world, rec)

    older = await request_run(_request(project, "arguments", "old", mode="regenerate"), store=store, deps=deps)
    newer = await request_run(_request(project, "arguments", "new", mode="regenerate"), store=store, deps=deps)
    assert newer.run.request_order > older.run.request_order

    assert await run_worker(newer.run.id, store=store, deps=deps) == "ready"
    assert await run_worker(older.run.id, store=store, deps=deps) == "superseded"

    scope = await store.get_scope(newer.run.scope_id)
    assert scope is not None and scope.current_run_id == newer.run.id
    published = await execute(
        pg_dsn,
        "SELECT count(*) FROM analysis_object_revision WHERE run_id = %s AND status = 'published'",
        (older.run.id,),
    )
    assert published == [(0,)]


@pytest.mark.asyncio
async def test_row_racing_edits_on_one_object_let_exactly_one_win(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    deps = _deps(world, rec)
    outcome = await request_run(_request(project, "arguments", "a1"), store=store, deps=deps)
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "ready"
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.output_manifest is not None

    revision_id = run.output_manifest["objects"][0]["revisionId"]
    revision = (await store.get_revisions(project, [revision_id]))[revision_id]
    record = await store.get_object(revision.object_id)
    assert record is not None and record.scope_id is not None

    def edit(text: str) -> Any:
        async def apply(racer: SqlAnalysisStore) -> ObjectRevision:
            return await RevisionService(racer).author_edit(
                project_id=project,
                object_id=revision.object_id,
                expected_revision_id=revision.id,
                payload={**revision.payload, "statement": text},
                actor_id="u1",
            )

        return apply

    results = await race(
        pg_dsn,
        "SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE",
        (record.scope_id,),
        edit("Edited first."),
        edit("Edited second."),
    )
    wins = [r for r in results if isinstance(r, ObjectRevision)]
    conflicts = [r for r in results if isinstance(r, RevisionConflict)]
    assert len(wins) == 1 and len(conflicts) == 1
    assert conflicts[0].current is not None and conflicts[0].current.id == wins[0].id
    assert (await store.get_object(revision.object_id)).current_revision_id == wins[0].id  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_row_two_requests_racing_with_one_key_get_one_run(pg_dsn: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    world = ProducerWorld.recording_debate()
    project = await new_project(pg_dsn)
    scope = await store.ensure_scope(
        project_id=project, kind="producer", owner_id="arguments", scope_key="project"  # type: ignore[arg-type]
    )

    async def ask(racer: SqlAnalysisStore) -> Any:
        return await request_run(
            _request(project, "arguments", "same"), store=racer, deps=_deps(world, rec)
        )

    first, second = await race(
        pg_dsn, "SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (scope.id,), ask, ask
    )
    assert not isinstance(first, BaseException) and not isinstance(second, BaseException), (first, second)
    assert first.run.id == second.run.id
    assert sorted([first.outcome, second.outcome]) == ["created", "existing"]
    assert await _count(pg_dsn, "analysis_run", project) == 1


# ── the in-memory store and the database agree ──────────────────────────


@pytest.mark.asyncio
async def test_the_two_stores_publish_the_same_output_for_the_same_world(pg_dsn: str) -> None:
    """The in-memory matrix is only evidence if the fake behaves as the
    database does for the same inputs."""
    sql_store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    sql_runs = await _chain(sql_store, project, ProducerWorld.recording_debate(), rec)

    memory_store, memory_rec = FakeAnalysisStore(), Recorder()
    memory_world = ProducerWorld.recording_debate()
    memory_world.verifier = merge_all(MERGED_RECORD)
    deps = memory_world.deps(memory_rec)
    outcome = await request_run(
        RunRequest(
            PROJECT,
            "tensions",
            "project",
            parameters={"input_set": "deduplicated_arguments"},
            idempotency_key="chain",
        ),
        store=memory_store,
        deps=deps,
    )
    arguments, dedup = outcome.dependencies
    for run_id in (arguments.id, dedup.id, outcome.run.id):
        assert await run_worker(run_id, store=memory_store, deps=deps) == "ready"
        await dispatch_events(store=memory_store, deps=memory_rec.outbox_deps())

    for recipe in CHAIN:
        sql_manifest = sql_runs[recipe].output_manifest or {}
        memory_scope = await memory_store.find_scope(
            project_id=PROJECT,
            kind="producer",  # type: ignore[arg-type]
            owner_id=recipe,
            scope_key="project",
        )
        assert memory_scope is not None and memory_scope.current_run_id
        memory_run = await memory_store.get_run(memory_scope.current_run_id)
        assert memory_run is not None and memory_run.output_manifest is not None
        assert len(sql_manifest["objects"]) == len(memory_run.output_manifest["objects"]), recipe
        assert len(sql_manifest["relations"]) == len(memory_run.output_manifest["relations"]), recipe
        assert [c["check"] for c in sql_runs[recipe].checks] == [c["check"] for c in memory_run.checks], recipe
