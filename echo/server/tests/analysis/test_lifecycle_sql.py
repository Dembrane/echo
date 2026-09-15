"""The executor, outbox, revisions and snapshots end to end against Postgres.

Uses the throwaway schema from `conftest.pg_dsn` and the fixture recipes. The
races run their writers on separate connections that meet at a lock a third
connection holds, so each compare-and-set meets real contention.
"""

from __future__ import annotations

import json
import uuid
import asyncio
from typing import Any

import pytest
import psycopg

from tests.analysis.helpers import Recorder
from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import race, execute, new_project
from dembrane.analysis.outbox import dispatch_events, consume_wake_waiting
from dembrane.analysis.planner import DependencyCycle
from dembrane.analysis.executor import RunRequest, run_worker, request_run, execute_inline
from dembrane.analysis.contracts import (
    Run,
    RunStatus,
    ScopeKind,
    OutboxEvent,
    OutboxStatus,
    ObjectRevision,
    RevisionConflict,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import ProducerRef, SnapshotRequest, assemble_snapshot
from tests.analysis.fixture_recipes import PAIRS, WORDS, CYCLE_A, FixtureWorld

pytestmark = pytest.mark.integration

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"


def _seed(world: FixtureWorld, project: str) -> None:
    world.sources[project] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


async def _request(store: SqlAnalysisStore, rec: Recorder, project: str, recipe: str = WORDS, **kwargs: Any) -> Any:
    scope_key = kwargs.pop("scope_key", "project")
    return await request_run(RunRequest(project, recipe, scope_key, **kwargs), store=store, deps=rec.deps())


async def _ready(store: SqlAnalysisStore, rec: Recorder, project: str, recipe: str = WORDS, **kwargs: Any) -> Run:
    outcome = await _request(store, rec, project, recipe, **kwargs)
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    run = await store.get_run(outcome.run.id)
    assert run is not None
    return run


async def _count(dsn: str, table: str, project: str) -> int:
    return int((await execute(dsn, f"SELECT count(*) FROM {table} WHERE project_id = %s", (project,)))[0][0])


@pytest.mark.asyncio
async def test_two_requests_racing_with_one_key_get_one_run(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    scope = await store.ensure_scope(project_id=project, kind=ScopeKind.PRODUCER, owner_id=WORDS, scope_key="project")

    async def ask(racer: SqlAnalysisStore) -> Any:
        return await request_run(RunRequest(project, WORDS, "project", idempotency_key="same"), store=racer, deps=rec.deps())

    first, second = await race(pg_dsn, "SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (scope.id,), ask, ask)
    assert first.run.id == second.run.id
    assert sorted([first.outcome, second.outcome]) == ["created", "existing"]
    assert await _count(pg_dsn, "analysis_run", project) == 1


@pytest.mark.asyncio
async def test_racing_refreshes_with_different_keys_share_one_run(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    scope = await store.ensure_scope(project_id=project, kind=ScopeKind.PRODUCER, owner_id=WORDS, scope_key="project")

    def ask(key: str) -> Any:
        async def run(racer: SqlAnalysisStore) -> Any:
            return await request_run(RunRequest(project, WORDS, "project", idempotency_key=key), store=racer, deps=rec.deps())

        return run

    left, right = await race(pg_dsn, "SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (scope.id,), ask("a"), ask("b"))
    assert left.run.id == right.run.id and await _count(pg_dsn, "analysis_run", project) == 1
    assert (await store.run_by_idempotency_key(project, "a")).id == (await store.run_by_idempotency_key(project, "b")).id  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_request_order_stops_an_older_run_publishing_over_a_newer_ready_one(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    older = await _request(store, rec, project, mode="regenerate", idempotency_key="old")
    newer = await _request(store, rec, project, mode="regenerate", idempotency_key="new")
    assert newer.run.request_order > older.run.request_order

    assert await run_worker(newer.run.id, store=store, deps=rec.deps()) == "ready"
    assert await run_worker(older.run.id, store=store, deps=rec.deps()) == "superseded"
    scope = await store.get_scope(newer.run.scope_id)
    assert scope is not None and scope.current_run_id == newer.run.id
    published = await execute(
        pg_dsn, "SELECT count(*) FROM analysis_object_revision WHERE run_id = %s AND status = 'published'", (older.run.id,)
    )
    assert published == [(0,)]


@pytest.mark.asyncio
async def test_a_replaced_lease_cannot_checkpoint_or_publish_and_the_next_worker_resumes(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    outcome = await _request(store, rec, project, idempotency_key="k")
    run_id = outcome.run.id
    first_lease: dict[str, str] = {}

    async def take_over(label: str) -> None:
        if label == f"extract:{C1}" and not first_lease:
            running = await store.get_run(run_id)
            assert running is not None and running.lease
            first_lease["value"] = running.lease
            await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (run_id,))
            assert (await store.claim_run(run_id, "second-worker", max_running=None)).outcome == "claimed"

    world.during_model = take_over
    assert await run_worker(run_id, store=store, deps=rec.deps()) == "stopped"
    old = first_lease["value"]
    assert await store.heartbeat_run(run_id, old, {}) is False
    empty = {"objects": [], "relations": [], "inputs": {}}
    assert (await store.publish_run(run_id, old, manifest=empty, checks=[], metrics={})).outcome == "inactive"
    completed = await execute(
        pg_dsn, "SELECT count(*) FROM analysis_step WHERE project_id = %s AND status = 'completed'", (project,)
    )
    assert completed == [(0,)]  # the old worker's answer never landed

    world.during_model = None
    await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (run_id,))
    assert await run_worker(run_id, store=store, deps=rec.deps()) == "ready"
    assert world.model_calls[f"{WORDS}:extract"] == 3


@pytest.mark.asyncio
async def test_retry_resumes_the_saved_steps(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    world.fail_conversations = {C2}
    outcome = await _request(store, rec, project, idempotency_key="k")
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "failed"
    world.fail_conversations = set()

    retry = await _request(store, rec, project, mode="retry", idempotency_key="again")
    assert retry.outcome == "requeued" and retry.run.id == outcome.run.id
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    assert world.model_calls[f"{WORDS}:extract"] == 3


@pytest.mark.parametrize("point", ["publish:locked", "publish:validated", "publish:heads", "publish:outbox"])
@pytest.mark.asyncio
async def test_a_crash_inside_publication_rolls_everything_back(pg_dsn: str, world: FixtureWorld, point: str) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    first = await _ready(store, rec, project, idempotency_key="k1")
    heads = await execute(pg_dsn, "SELECT id, current_revision_id FROM analysis_object WHERE project_id = %s ORDER BY id", (project,))
    world.sources[project][C2] = ["Bikes are healthy and quick."]

    def crash(at: str) -> None:
        if at == point:
            raise RuntimeError(f"crashed at {at}")

    crashing = SqlAnalysisStore(dsn=pg_dsn, fault=crash)
    second = await _request(store, rec, project, idempotency_key="k2")
    assert await run_worker(second.run.id, store=crashing, deps=rec.deps()) == "failed"

    scope = await store.get_scope(first.scope_id)
    assert scope is not None and scope.current_run_id == first.id and scope.publication_sequence == 1
    assert await execute(pg_dsn, "SELECT id, current_revision_id FROM analysis_object WHERE project_id = %s ORDER BY id", (project,)) == heads
    assert await _count(pg_dsn, "analysis_outbox", project) == 1
    statuses = await execute(pg_dsn, "SELECT status FROM analysis_object_revision WHERE run_id = %s", (second.run.id,))
    assert statuses == [("staged",)]
    assert (await store.get_run(second.run.id)).status == RunStatus.FAILED  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_an_outbox_event_is_retried_after_a_failed_dispatch_and_duplicates_start_nothing(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    outcome = await _request(store, rec, project, PAIRS, idempotency_key="p")
    (words,) = outcome.dependencies
    assert await run_worker(words.id, store=store, deps=rec.deps()) == "ready"

    # The module shares one schema: dispatch this test's event by id.
    ((event_id,),) = await execute(pg_dsn, "SELECT id::text FROM analysis_outbox WHERE run_id = %s", (words.id,))
    rec.publish_error = RuntimeError("redis is down")
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id)).retried == 1
    ((status, attempts, error, consumers),) = await execute(
        pg_dsn,
        "SELECT status, attempts, last_error, consumers::text FROM analysis_outbox WHERE id = %s",
        (event_id,),
    )
    # Consumers are isolated: the page nudge and the wake-up (which also
    # publishes) failed, the snapshot hooks ran and are recorded.
    assert (status, attempts) == ("pending", 1) and error.startswith("RuntimeError")
    assert set(json.loads(consumers)) == {"view_snapshots"}
    rec.publish_error = None
    await execute(pg_dsn, "UPDATE analysis_outbox SET next_attempt_at = now() WHERE id = %s", (event_id,))

    # A dispatcher holding the event makes the others skip it, never wait.
    async with await psycopg.AsyncConnection.connect(pg_dsn) as holder:
        await holder.execute("SELECT 1 FROM analysis_outbox WHERE id = %s FOR UPDATE", (event_id,))
        skipped = await asyncio.wait_for(
            dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id), timeout=10
        )
        assert skipped.claimed == 0
        await holder.rollback()

    reports = await asyncio.gather(
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id),
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id),
    )
    assert sum(r.claimed for r in reports) == 1 and sum(r.delivered for r in reports) == 1
    assert rec.dispatched.count(outcome.run.id) == 1

    replay = OutboxEvent(id=event_id, project_id=project, scope_id=words.scope_id, sequence=1, event_type="run_published", status=OutboxStatus.DELIVERED, run_id=words.id)
    await consume_wake_waiting(replay, store, rec.outbox_deps())
    assert rec.dispatched.count(outcome.run.id) == 1
    ((final_status, final_consumers),) = await execute(
        pg_dsn, "SELECT status, consumers::jsonb FROM analysis_outbox WHERE id = %s", (event_id,)
    )
    assert final_status == "delivered" and set(final_consumers) == {"live_event", "wake_waiting", "view_snapshots"}


@pytest.mark.asyncio
async def test_racing_edits_with_one_expected_revision_let_one_win(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    run = await _ready(store, rec, project, idempotency_key="k")
    revision_id = run.output_manifest["objects"][0]["revisionId"]  # type: ignore[index]
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
        pg_dsn, "SELECT 1 FROM analysis_scope WHERE id = %s FOR UPDATE", (record.scope_id,), edit("First edit."), edit("Second edit.")
    )
    wins = [r for r in results if isinstance(r, ObjectRevision)]
    conflicts = [r for r in results if isinstance(r, RevisionConflict)]
    assert len(wins) == 1 and len(conflicts) == 1
    assert conflicts[0].current is not None and conflicts[0].current.id == wins[0].id
    assert (await store.get_object(revision.object_id)).current_revision_id == wins[0].id  # type: ignore[union-attr]
    events = await execute(pg_dsn, "SELECT count(*) FROM analysis_outbox WHERE project_id = %s AND event_type = 'revision_published'", (project,))
    assert events == [(1,)]


@pytest.mark.asyncio
async def test_a_waiting_run_wakes_on_its_dependencys_publication_and_pins_that_manifest(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    outcome = await _request(store, rec, project, PAIRS, idempotency_key="p")
    (words,) = outcome.dependencies
    assert outcome.run.status == RunStatus.WAITING_FOR_INPUTS
    assert await run_worker(words.id, store=store, deps=rec.deps()) == "ready"
    ((event_id,),) = await execute(pg_dsn, "SELECT id::text FROM analysis_outbox WHERE run_id = %s", (words.id,))
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id)).delivered == 1
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"

    pairs = await store.get_run(outcome.run.id)
    published_words = await store.get_run(words.id)
    assert pairs is not None and published_words is not None
    pinned = pairs.input_manifest["dependencies"]["arguments"]  # type: ignore[index]
    assert pinned["runId"] == words.id and pinned["manifestHash"] == published_words.output_manifest["contentHash"]  # type: ignore[index]
    argument_revisions = {o["revisionId"] for o in published_words.output_manifest["objects"]}  # type: ignore[index]
    assert {r["from"] for r in pairs.output_manifest["relations"]} <= argument_revisions  # type: ignore[index]


@pytest.mark.asyncio
async def test_a_dependency_cycle_is_rejected_before_anything_is_written(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    with pytest.raises(DependencyCycle, match=f"{CYCLE_A}@project"):
        await _request(store, rec, project, CYCLE_A)
    assert await _count(pg_dsn, "analysis_scope", project) == 0 and world.total_model_calls() == 0


@pytest.mark.asyncio
async def test_an_invalid_reference_fails_the_run_and_keeps_the_ready_output(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project, other = await new_project(pg_dsn), await new_project(pg_dsn)
    _seed(world, project)
    _seed(world, other)
    foreign_run = await _ready(store, rec, other, idempotency_key="f")
    foreign_id = foreign_run.output_manifest["objects"][0]["revisionId"]  # type: ignore[index]
    first = await execute_inline(RunRequest(project, PAIRS, "project", idempotency_key="p1"), store=store, deps=rec.deps())
    assert first.run.status == RunStatus.READY

    world.foreign_revision = (await store.get_revisions(other, [foreign_id]))[foreign_id]
    second = await execute_inline(RunRequest(project, PAIRS, "project", mode="regenerate", idempotency_key="p2"), store=store, deps=rec.deps())
    assert second.run.status == RunStatus.FAILED
    scope = await store.get_scope(first.run.scope_id)
    assert scope is not None and scope.current_run_id == first.run.id


@pytest.mark.asyncio
async def test_one_scope_failing_leaves_another_scopes_output(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    c1 = await _ready(store, rec, project, scope_key=f"conversation:{C1}", idempotency_key="c1")
    c2 = await _ready(store, rec, project, scope_key=f"conversation:{C2}", idempotency_key="c2")
    world.sources[project][C2] = ["Bikes are healthy and quick."]
    world.fail_conversations = {C2}
    broken = await _request(store, rec, project, scope_key=f"conversation:{C2}", idempotency_key="c2b")
    assert await run_worker(broken.run.id, store=store, deps=rec.deps()) == "failed"

    currents = await execute(pg_dsn, "SELECT scope_key, current_run_id::text FROM analysis_scope WHERE project_id = %s ORDER BY scope_key", (project,))
    assert currents == [(f"conversation:{C1}", c1.id), (f"conversation:{C2}", c2.id)]
    published = await execute(pg_dsn, "SELECT count(*) FROM analysis_object_revision WHERE project_id = %s AND status = 'published'", (project,))
    assert published == [(3,)]


@pytest.mark.asyncio
async def test_refresh_reuses_unchanged_work_and_recomputes_only_a_changed_conversation(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    first = await _ready(store, rec, project, idempotency_key="k1")
    calls = world.total_model_calls()

    reuse = await _request(store, rec, project, idempotency_key="k2")
    assert reuse.outcome == "reused" and reuse.run.reused_run_id == first.id and world.total_model_calls() == calls

    world.sources[project][C2] = ["Bikes are healthy and quick."]
    changed = await _ready(store, rec, project, idempotency_key="k3")
    assert world.model_calls[f"{WORDS}:extract"] == calls + 1
    assert changed.metrics["cacheHits"] == 1 and changed.metrics["objectsReused"] == 2


@pytest.mark.asyncio
async def test_regenerate_keeps_its_key_opens_a_new_epoch_and_reuses_identical_embeddings(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    await _ready(store, rec, project, idempotency_key="k1")
    embeds = len(world.embed_calls)

    regenerate = await _request(store, rec, project, mode="regenerate", idempotency_key="g1")
    assert (await _request(store, rec, project, mode="regenerate", idempotency_key="g1")).run.id == regenerate.run.id
    assert await run_worker(regenerate.run.id, store=store, deps=rec.deps()) == "ready"
    assert world.model_calls[f"{WORDS}:extract"] == 4 and len(world.embed_calls) == embeds
    newer = await _request(store, rec, project, mode="regenerate", idempotency_key="g2")
    assert newer.outcome == "created" and newer.run.epoch == regenerate.run.epoch + 1


@pytest.mark.asyncio
async def test_deleting_a_project_removes_every_analysis_row(pg_dsn: str, world: FixtureWorld) -> None:
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project, keeper = await new_project(pg_dsn), await new_project(pg_dsn)
    for owner in (project, keeper):
        _seed(world, owner)
        await execute_inline(RunRequest(owner, PAIRS, "project", idempotency_key=f"p-{uuid.uuid4()}"), store=store, deps=rec.deps())
        await assemble_snapshot(
            SnapshotRequest(owner, "map", "project", (ProducerRef(WORDS, "project"), ProducerRef(PAIRS, "project"))), store=store
        )
    tables = (
        "analysis_scope", "analysis_run", "analysis_step", "analysis_object", "analysis_object_revision",
        "analysis_relation", "analysis_snapshot", "analysis_outbox", "analysis_request_key", "map_embedding",
    )  # fmt: skip
    kept = {table: await _count(pg_dsn, table, keeper) for table in tables}
    assert all(kept.values())

    await execute(pg_dsn, "DELETE FROM project WHERE id = %s", (project,))
    assert {table: await _count(pg_dsn, table, project) for table in tables} == dict.fromkeys(tables, 0)
    assert {table: await _count(pg_dsn, table, keeper) for table in tables} == kept
