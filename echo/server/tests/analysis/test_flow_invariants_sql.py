"""Analysis runs and the Map, end to end, against Postgres.

The twins of `test_flow_invariants.py` whose guarantee is the database's own:
the claim that refuses a live lease, one publication transaction with its
outbox row, the outbox claim the sweep makes, and the two gaps whose fix is a
statement (`expire_stale_runs`, `create_run`). Everything runs on the
throwaway schema from `conftest.pg_dsn` with the fixture recipes; the Map
routes read that schema through `SqlMapStore` and `SqlMapViewReads`. The
schema is shared by the module, so every query here is scoped to the test's
own project, run or event.
"""

from __future__ import annotations

import json
from typing import Any, Iterator
from collections import Counter

import pytest

import dembrane.analysis.map_view as map_view
from dembrane.map.store import SqlMapStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import execute, new_project
from dembrane.analysis.outbox import sweep, dispatch_events
from tests.analysis.flow_fakes import (
    PAIRS_ON_ARGUMENTS,
    MapRoutes,
    WorkerDied,
    given,
    generation_recipes,
)
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.map_view import SqlMapViewReads, current_map_snapshot
from dembrane.analysis.contracts import RunStatus, StepStatus
from tests.analysis.fixture_recipes import WORDS, FixtureWorld

pytestmark = pytest.mark.integration

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
C3 = "aaaaaaaa-0000-4000-8000-000000000003"
EXTRACT = f"{WORDS}:extract"
REVIEW = "Review 2026-09-23 analysis"


def _seed(world: FixtureWorld, project: str) -> None:
    world.sources[project] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


@pytest.fixture
def generation(world: FixtureWorld) -> Iterator[FixtureWorld]:
    with generation_recipes():
        yield world


async def _routes(monkeypatch: pytest.MonkeyPatch, dsn: str, world: FixtureWorld, rec: Recorder) -> tuple[MapRoutes, SqlAnalysisStore, SqlMapViewReads]:
    project = await new_project(dsn)
    _seed(world, project)
    store, reads = SqlAnalysisStore(dsn=dsn), SqlMapViewReads(dsn)
    routes = MapRoutes(monkeypatch, project_id=project, store=store, map_store=SqlMapStore(dsn), reads=reads, rec=rec)
    return routes, store, reads


async def _event_of(dsn: str, run_id: str) -> tuple[str, str, str, int]:
    ((event_id, event_type, status, sequence),) = await execute(
        dsn, "SELECT id::text, event_type, status, sequence FROM analysis_outbox WHERE run_id = %s", (run_id,)
    )
    return event_id, event_type, status, sequence


async def _status(store: SqlAnalysisStore, run_id: str) -> RunStatus:
    run = await store.get_run(run_id)
    assert run is not None
    return run.status


async def _drain(dsn: str, store: SqlAnalysisStore, rec: Recorder, project: str) -> None:
    """Work this project's queue as the dispatcher and the workers would."""
    for _ in range(10):
        pending = await execute(
            dsn, "SELECT id::text FROM analysis_outbox WHERE project_id = %s AND status = 'pending'", (project,)
        )
        for (event_id,) in pending:
            await dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event_id)
        queued = await execute(dsn, "SELECT id::text FROM analysis_run WHERE project_id = %s AND status = 'queued'", (project,))
        if not queued:
            return
        for (run_id,) in queued:
            await run_worker(run_id, store=store, deps=rec.deps())


# ── the core flow ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_map_generation_publishes_once_then_the_outbox_wakes_its_dependant_and_moves_the_map(
    pg_dsn: str, generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Breaks if `publish_run` stops committing heads, the ready run, the
    scope's current run and the outbox row in one transaction, or if the
    dispatcher stops waking waiters or running the map view hook."""
    rec = Recorder()
    routes, store, reads = await _routes(monkeypatch, pg_dsn, generation, rec)
    project = routes.project_id

    accepted = await routes.generate()
    assert accepted.status_code == 202
    run_id = accepted.json()["attempt"]["id"]
    assert accepted.json()["attempt"]["status"] == "queued" and rec.dispatched == [run_id]
    dependant = await request_run(
        RunRequest(project, PAIRS_ON_ARGUMENTS, "project", idempotency_key="pairs"), store=store, deps=rec.deps()
    )
    assert [run.id for run in dependant.dependencies] == [run_id]
    assert dependant.run.status == RunStatus.WAITING_FOR_INPUTS and rec.dispatched == [run_id]

    seen: list[tuple[Any, ...]] = []

    async def look(_label: str) -> None:
        run = await store.get_run(run_id)
        assert run is not None
        scope = await store.get_scope(run.scope_id)
        steps = await store.get_steps(run_id)
        published = await execute(pg_dsn, "SELECT count(*) FROM analysis_object_revision WHERE run_id = %s AND status = 'published'", (run_id,))
        seen.append(
            (
                run.status,
                run.attempt,
                run.lease,
                sorted(s.step_key for s in steps if s.status == StepStatus.RUNNING),
                sorted(s.step_key for s in steps if s.status == StepStatus.COMPLETED),
                scope.current_run_id if scope else "missing",
                published[0][0],
            )
        )

    generation.during_model = look
    assert await run_worker(run_id, store=store, deps=rec.deps()) == "ready"
    lease = seen[0][2]
    assert lease and seen == [
        (RunStatus.RUNNING, 1, lease, [f"extract:{C1}"], [], None, 0),
        (RunStatus.RUNNING, 1, lease, [f"extract:{C2}"], [f"extract:{C1}"], None, 0),
    ]

    run = await store.get_run(run_id)
    assert run is not None and run.status == RunStatus.READY and run.output_manifest is not None
    heads = {o["objectId"]: o["revisionId"] for o in run.output_manifest["objects"]}
    stored = await execute(pg_dsn, "SELECT id::text, current_revision_id::text FROM analysis_object WHERE project_id = %s", (project,))
    assert len(heads) == 3 and dict(stored) == heads
    assert await execute(pg_dsn, "SELECT DISTINCT status FROM analysis_object_revision WHERE run_id = %s", (run_id,)) == [("published",)]
    scope = await store.get_scope(run.scope_id)
    assert scope is not None and (scope.current_run_id, scope.publication_sequence) == (run_id, 1)
    event_id, event_type, status, sequence = await _event_of(pg_dsn, run_id)
    assert (event_type, status, sequence) == ("run_published", "pending", 1) and rec.enqueued == [event_id]
    assert await _status(store, dependant.run.id) == RunStatus.WAITING_FOR_INPUTS
    assert await execute(pg_dsn, "SELECT count(*) FROM analysis_snapshot WHERE project_id = %s", (project,)) == [(0,)]

    hooks = [map_view.map_view_hook]
    report = await dispatch_events(store=store, deps=rec.outbox_deps(hooks=hooks), event_id=event_id)
    assert (report.claimed, report.delivered) == (1, 1)
    ((final, consumers),) = await execute(pg_dsn, "SELECT status, consumers::text FROM analysis_outbox WHERE id = %s", (event_id,))
    assert final == "delivered" and set(json.loads(consumers)) == {"live_event", "wake_waiting", "view_snapshots"}
    assert await _status(store, dependant.run.id) == RunStatus.QUEUED and rec.dispatched == [run_id, dependant.run.id]
    view = await current_map_snapshot(project, store=store, reads=reads, follow=False)
    assert view is not None and view.source_event_id == event_id
    assert {o["revisionId"] for o in view.manifest["objects"]} == set(heads.values())

    graph = await routes.graph(types="argument")
    assert graph.status_code == 200 and graph.json()["snapshot"]["id"] == view.id
    assert sorted(node["revisionId"] for node in graph.json()["nodes"]) == sorted(heads.values())
    assert await execute(
        pg_dsn, "SELECT count(*) FROM map_result WHERE snapshot_id = %s AND manifest_version = 2", (view.id,)
    ) == [(1,)]

    assert await run_worker(dependant.run.id, store=store, deps=rec.deps()) == "ready"
    pairs_event, *_rest = await _event_of(pg_dsn, dependant.run.id)
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(hooks=hooks), event_id=pairs_event)).delivered == 1
    following = await current_map_snapshot(project, store=store, reads=reads, follow=False)
    assert following is not None and following.parent_snapshot_id == view.id
    tensions = (await routes.graph(types="tension")).json()
    assert tensions["snapshot"]["id"] == following.id and len(tensions["nodes"]) == 1


@pytest.mark.asyncio
async def test_a_duplicate_message_for_a_running_run_starts_nothing(pg_dsn: str, world: FixtureWorld) -> None:
    """Breaks if `claim_run`'s WHERE clause took over a running run whose
    lease is still live: two workers would pay for the same steps."""
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    outcome = await request_run(RunRequest(project, WORDS, "project", idempotency_key="k"), store=store, deps=rec.deps())
    second: list[str] = []

    async def deliver_again(_label: str) -> None:
        if not second:
            second.append(await run_worker(outcome.run.id, store=store, deps=rec.deps()))

    world.during_model = deliver_again
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    assert second == ["skipped"]
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.attempt == 1 and world.model_calls[EXTRACT] == 2


@pytest.mark.asyncio
async def test_a_worker_that_dies_between_publication_and_enqueue_is_healed_by_the_minute_sweep(
    pg_dsn: str, generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Breaks if the sweep's outbox claim stops picking up pending rows whose
    after-commit message never went out, or publication stops writing the
    row in its own transaction."""
    rec = Recorder()
    routes, store, reads = await _routes(monkeypatch, pg_dsn, generation, rec)
    project = routes.project_id
    run_id = (await routes.generate()).json()["attempt"]["id"]
    dependant = await request_run(
        RunRequest(project, PAIRS_ON_ARGUMENTS, "project", idempotency_key="pairs"), store=store, deps=rec.deps()
    )
    deps = rec.deps()

    def die(_event_id: str) -> None:
        raise WorkerDied()

    deps.enqueue_outbox = die
    with pytest.raises(WorkerDied):
        await run_worker(run_id, store=store, deps=deps)
    assert await _status(store, run_id) == RunStatus.READY
    event_id, _type, status, _sequence = await _event_of(pg_dsn, run_id)
    assert status == "pending" and await _status(store, dependant.run.id) == RunStatus.WAITING_FOR_INPUTS

    await sweep(store=store, deps=rec.outbox_deps(hooks=[map_view.map_view_hook]))
    assert (await _event_of(pg_dsn, run_id))[2] == "delivered"
    assert await _status(store, dependant.run.id) == RunStatus.QUEUED and rec.dispatched.count(dependant.run.id) == 1
    view = await current_map_snapshot(project, store=store, reads=reads, follow=False)
    assert view is not None and view.source_event_id == event_id


# ── gaps ────────────────────────────────────────────────────────────────


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #2: a lapsed lease fails the run instead of re-queueing it")
@pytest.mark.asyncio
async def test_a_run_whose_worker_died_is_requeued_by_the_sweep_and_resumes_its_saved_steps(pg_dsn: str, world: FixtureWorld) -> None:
    """`expire_stale_runs` queues a run whose lease lapsed again while it is
    below three attempts; the next worker resumes the steps the dead one saved."""
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    calls: Counter[str] = Counter()

    async def die_on_the_second(label: str) -> None:
        calls[label] += 1
        if label == f"extract:{C2}" and calls[label] == 1:
            raise WorkerDied()

    world.during_model = die_on_the_second
    run_id = (await request_run(RunRequest(project, WORDS, "project", idempotency_key="k"), store=store, deps=rec.deps())).run.id
    with pytest.raises(WorkerDied):
        await run_worker(run_id, store=store, deps=rec.deps())
    steps = {s.step_key: s.status for s in await store.get_steps(run_id)}
    given(await _status(store, run_id) == RunStatus.RUNNING, "the dead worker left its run running")
    given(steps == {f"extract:{C1}": StepStatus.COMPLETED, f"extract:{C2}": StepStatus.RUNNING}, "one step saved")

    await execute(pg_dsn, "UPDATE analysis_run SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (run_id,))
    await sweep(store=store, deps=rec.outbox_deps())
    swept = await store.get_run(run_id)
    given(swept is not None, "the run is still there")
    assert swept is not None and (swept.status, swept.error) == (RunStatus.QUEUED, None)
    if rec.dispatched.count(run_id) < 2:
        await execute(pg_dsn, "UPDATE analysis_run SET updated_at = now() - interval '1 hour' WHERE id = %s", (run_id,))
        await sweep(store=store, deps=rec.outbox_deps())
    assert rec.dispatched.count(run_id) == 2

    assert await run_worker(run_id, store=store, deps=rec.deps()) == "ready"
    resumed = await store.get_run(run_id)
    assert resumed is not None and resumed.attempt == 2 and resumed.metrics["stepsResumed"] == 1
    assert calls == {f"extract:{C1}": 1, f"extract:{C2}": 2}


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #5: a refresh during a running run re-extracts what that run is extracting")
@pytest.mark.asyncio
async def test_a_refresh_during_a_running_run_waits_for_it_and_pays_only_for_the_new_conversation(pg_dsn: str, world: FixtureWorld) -> None:
    """`create_run` keeps one running run per producer scope: a newcomer with
    other inputs waits on it and reuses its steps when it wakes, so each
    conversation is read once and the current output covers all three."""
    store, rec = SqlAnalysisStore(dsn=pg_dsn), Recorder()
    project = await new_project(pg_dsn)
    _seed(world, project)
    calls: Counter[str] = Counter()
    newcomer: list[str] = []

    async def refresh_meanwhile(label: str) -> None:
        calls[label] += 1
        if label == f"extract:{C1}" and not newcomer:
            world.sources[project][C3] = ["Ferries are slow."]
            second = await request_run(RunRequest(project, WORDS, "project", idempotency_key="k2"), store=store, deps=rec.deps())
            newcomer.append(second.run.id)
            await run_worker(second.run.id, store=store, deps=rec.deps())

    world.during_model = refresh_meanwhile
    first = await request_run(RunRequest(project, WORDS, "project", idempotency_key="k1"), store=store, deps=rec.deps())
    await run_worker(first.run.id, store=store, deps=rec.deps())
    await _drain(pg_dsn, store, rec, project)

    given(len(newcomer) == 1, "the second refresh was requested")
    assert calls == {f"extract:{C1}": 1, f"extract:{C2}": 1, f"extract:{C3}": 1}
    scope = await store.get_scope(first.run.scope_id)
    assert scope is not None and scope.current_run_id is not None
    current = await store.get_run(scope.current_run_id)
    assert current is not None and len((current.output_manifest or {}).get("objects") or []) == 4
