"""Analysis runs and the Map, end to end, on the in-memory store.

The core flow: a Map generate request is an executor refresh answered with 202
and the run; a worker claims it under a lease and checkpoints its steps; one
publication advances the heads, makes the run ready and current and writes the
outbox row; dispatching that row wakes a waiting dependant and advances the
map view; the graph route serves the new view. Fakes stand only at the edges:
the model (scripted fixture recipes), Redis nudges, Directus access and the
clock (`FakeAnalysisStore` keeps the guards the SQL keeps; the Postgres twins
are in `test_flow_invariants_sql.py`).

Passing tests lock in what the code already keeps; each names the change that
would break it. The strict xfails are the gaps named in the review of
September 23rd 2026 ("Ticks, analysis and Map against Temporal's patterns"),
written as the behaviour wanted, so each passes once its gap is closed. They
expect an `AssertionError` only: a precondition that does not hold is raised
as `SetupFailed` and fails the test outright.
"""

from __future__ import annotations

import asyncio
from typing import Any, Iterator
from collections import Counter

import pytest

import dembrane.map.store as map_store_module
import dembrane.map.events as map_events
import dembrane.map.fact_check as fact_check
import dembrane.analysis.map_view as map_view
from dembrane.map import service
from tests.map_fakes import PROJECT, FakeAsyncRedis
from dembrane.analysis import outbox
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.outbox import QUEUED_REDISPATCH_SECONDS, sweep, dispatch_events
from tests.analysis.flow_fakes import (
    PARALLEL,
    ARGUMENTS,
    PAIRS_ON_ARGUMENTS,
    MapRoutes,
    WorkerDied,
    given,
    parallel_recipe,
    generation_recipes,
)
from dembrane.analysis.executor import RunRequest, cancel_run, run_worker, request_run
from dembrane.analysis.registry import get_recipe, register_recipe, unregister_recipe
from dembrane.analysis.contracts import (
    DEFAULT_LEASE_SECONDS,
    RunStatus,
    StepStatus,
    OutboxStatus,
    RevisionStatus,
    AnalysisStoreError,
)
from tests.analysis.map_v2_fakes import MapWorld, inline
from tests.analysis.producer_fakes import C2 as BOB, PROJECT as DEBATE, ProducerWorld
from tests.analysis.fixture_recipes import WORDS, FixtureWorld

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
C3 = "aaaaaaaa-0000-4000-8000-000000000003"
CLAIM = "Buses are cheaper."
EXTRACT = f"{WORDS}:extract"
REVIEW = "Review 2026-09-23 analysis"


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", CLAIM], C2: ["Bikes are healthy."]}


@pytest.fixture
def generation(world: FixtureWorld) -> Iterator[FixtureWorld]:
    """Two conversations, and the words recipe standing in for `arguments`."""
    _seed(world)
    with generation_recipes():
        yield world


def _routes(monkeypatch: pytest.MonkeyPatch, maps: MapWorld, rec: Recorder) -> MapRoutes:
    return MapRoutes(
        monkeypatch, project_id=PROJECT, store=maps.store, map_store=maps.map_store, reads=maps.reads, rec=rec
    )


def _words(key: str) -> RunRequest:
    return RunRequest(PROJECT, WORDS, "project", idempotency_key=key)


async def _drain(store: FakeAnalysisStore, rec: Recorder) -> None:
    """Work the queue as the dispatcher and the workers would, until it is empty."""
    for _ in range(10):
        await dispatch_events(store=store, deps=rec.outbox_deps())
        queued = [run.id for run in store.runs.values() if run.status == RunStatus.QUEUED]
        if not queued:
            return
        for run_id in queued:
            await run_worker(run_id, store=store, deps=rec.deps())


# ── the core flow ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_map_generation_publishes_once_then_the_outbox_wakes_its_dependant_and_moves_the_map(
    generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Generate, work, publish, dispatch, read: every hand-off of the flow.

    Breaks if publication stops committing the heads, the current run and the
    outbox row together, or if dispatching the row stops waking waiters or
    running the map view hook (the dependant would wait, the Map would stay
    empty until some read caught it up)."""
    maps, rec = MapWorld(), Recorder()
    routes = _routes(monkeypatch, maps, rec)

    accepted = await routes.generate()
    assert accepted.status_code == 202
    run_id = accepted.json()["attempt"]["id"]
    assert accepted.json()["attempt"]["status"] == "queued" and rec.dispatched == [run_id]
    assert maps.store.runs[run_id].recipe_id == ARGUMENTS and "queued" in routes.event_types()

    # A dependant asked for meanwhile joins the generation instead of starting its own.
    dependant = await request_run(
        RunRequest(PROJECT, PAIRS_ON_ARGUMENTS, "project", idempotency_key="pairs"), store=maps.store, deps=rec.deps()
    )
    assert [run.id for run in dependant.dependencies] == [run_id]
    assert dependant.run.status == RunStatus.WAITING_FOR_INPUTS and dependant.run.depends_on == [run_id]
    assert len(maps.store.runs) == 2 and rec.dispatched == [run_id]

    seen: list[dict[str, Any]] = []

    async def look(_label: str) -> None:
        run = maps.store.runs[run_id]
        steps = [s for s in maps.store.steps.values() if s.run_id == run_id]
        seen.append(
            {
                "status": run.status,
                "attempt": run.attempt,
                "lease": run.lease,
                "running": sorted(s.step_key for s in steps if s.status == StepStatus.RUNNING),
                "completed": sorted(s.step_key for s in steps if s.status == StepStatus.COMPLETED),
                "current": maps.store.scopes[run.scope_id].current_run_id,
                "published": sum(1 for v in maps.store.revisions.values() if v.status == RevisionStatus.PUBLISHED),
            }
        )

    generation.during_model = look
    assert await run_worker(run_id, store=maps.store, deps=rec.deps()) == "ready"

    # One lease, one step at a time, each saved before the next; nothing visible yet.
    assert [(s["status"], s["attempt"], s["running"], s["completed"]) for s in seen] == [
        (RunStatus.RUNNING, 1, [f"extract:{C1}"], []),
        (RunStatus.RUNNING, 1, [f"extract:{C2}"], [f"extract:{C1}"]),
    ]
    assert len({s["lease"] for s in seen}) == 1 and seen[0]["lease"]
    assert all(s["current"] is None and s["published"] == 0 for s in seen)

    # The publication: heads, the ready run, the scope's current output and the outbox row.
    run = maps.store.runs[run_id]
    assert run.status == RunStatus.READY and run.output_manifest is not None
    heads = {o["objectId"]: o["revisionId"] for o in run.output_manifest["objects"]}
    assert len(heads) == 3
    assert {object_id: maps.store.objects[object_id].current_revision_id for object_id in heads} == heads
    assert {maps.store.revisions[rid].status for rid in heads.values()} == {RevisionStatus.PUBLISHED}
    scope = maps.store.scopes[run.scope_id]
    assert (scope.current_run_id, scope.publication_sequence) == (run_id, 1)
    (event,) = [e for e in maps.store.outbox.values() if e.run_id == run_id]
    assert (event.event_type, event.status, event.sequence) == ("run_published", OutboxStatus.PENDING, 1)
    assert rec.enqueued == [event.id]
    # Until the event is dispatched the dependant waits and the Map has no view.
    assert maps.store.runs[dependant.run.id].status == RunStatus.WAITING_FOR_INPUTS
    assert maps.store.snapshots == {}

    hooks = [map_view.map_view_hook]
    report = await dispatch_events(store=maps.store, deps=rec.outbox_deps(hooks=hooks), event_id=event.id)
    assert (report.claimed, report.delivered) == (1, 1)
    delivered = maps.store.outbox[event.id]
    assert delivered.status == OutboxStatus.DELIVERED
    assert set(delivered.consumers) == {"live_event", "wake_waiting", "view_snapshots"}
    assert maps.store.runs[dependant.run.id].status == RunStatus.QUEUED
    assert rec.dispatched == [run_id, dependant.run.id]
    view = maps.current()
    assert view.source_event_id == event.id
    assert {o["revisionId"] for o in view.manifest["objects"]} == set(heads.values())

    # The Map reads the view the outbox made; the read did not have to catch it up.
    graph = await routes.graph(types="argument")
    assert graph.status_code == 200
    assert graph.json()["snapshot"]["id"] == view.id == maps.current().id
    assert sorted(node["revisionId"] for node in graph.json()["nodes"]) == sorted(heads.values())

    # The woken dependant publishes, and its output reaches the Map the same way.
    assert await run_worker(dependant.run.id, store=maps.store, deps=rec.deps()) == "ready"
    (pairs_event,) = [e for e in maps.store.outbox.values() if e.run_id == dependant.run.id]
    deps = rec.outbox_deps(hooks=hooks)
    assert (await dispatch_events(store=maps.store, deps=deps, event_id=pairs_event.id)).delivered == 1
    following = maps.current()
    assert following.source_event_id == pairs_event.id
    assert following.parent_snapshot_id == view.id
    tensions = (await routes.graph(types="tension")).json()
    assert tensions["snapshot"]["id"] == following.id and len(tensions["nodes"]) == 1


@pytest.mark.asyncio
async def test_pressing_generate_again_while_the_run_is_queued_or_running_returns_that_run(
    generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Breaks if an equivalent refresh stops joining its scope's active run
    (the request fingerprint, or the active-run lookup under the scope lock):
    every press would pay for another extraction."""
    maps, rec = MapWorld(), Recorder()
    routes = _routes(monkeypatch, maps, rec)
    first = (await routes.generate()).json()["attempt"]
    queued_again = (await routes.generate()).json()["attempt"]
    assert queued_again["id"] == first["id"] and queued_again["status"] == "queued"

    pressed: list[dict[str, Any]] = []

    async def press(_label: str) -> None:
        if not pressed:
            pressed.append((await routes.generate()).json()["attempt"])

    generation.during_model = press
    assert await run_worker(first["id"], store=maps.store, deps=rec.deps()) == "ready"
    assert pressed[0]["id"] == first["id"] and pressed[0]["status"] == "extracting"
    assert rec.dispatched == [first["id"]] and len(maps.store.runs) == 1
    assert generation.model_calls[EXTRACT] == 2


@pytest.mark.asyncio
async def test_a_duplicate_message_for_a_running_run_starts_nothing(generation: FixtureWorld) -> None:
    """Dramatiq may deliver a run twice, and the sweep re-sends queued runs on
    purpose. Breaks if `claim_run` took over a running run whose lease is
    still live: two workers would pay for the same steps."""
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(_words("k"), store=store, deps=rec.deps())
    second: list[str] = []

    async def deliver_again(_label: str) -> None:
        if not second:
            second.append(await run_worker(outcome.run.id, store=store, deps=rec.deps()))

    generation.during_model = deliver_again
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    assert second == ["skipped"]
    assert store.runs[outcome.run.id].attempt == 1 and generation.model_calls[EXTRACT] == 2


@pytest.mark.asyncio
async def test_generating_again_after_a_failed_run_pays_only_for_the_conversation_that_failed(
    generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Map's button always asks for a refresh, never a retry, so the new
    run gets the failed run's finished steps from the project's step cache.

    Breaks if the step cache stops offering completed steps of failed runs, or
    a step's cache key comes to name its run."""
    maps, rec = MapWorld(), Recorder()
    routes = _routes(monkeypatch, maps, rec)
    generation.fail_conversations = {C2}
    failed_id = (await routes.generate()).json()["attempt"]["id"]
    assert await run_worker(failed_id, store=maps.store, deps=rec.deps()) == "failed"
    analysis = service.MapAnalysis(store=maps.store, reads=maps.reads)
    current, shown = await service.project_rows(PROJECT, maps.map_store, analysis)
    assert current is None and shown is not None and (shown["id"], shown["status"]) == (failed_id, "failed")

    generation.fail_conversations = set()
    attempt = (await routes.generate()).json()["attempt"]
    assert attempt["id"] != failed_id and attempt["status"] == "queued"
    assert await run_worker(attempt["id"], store=maps.store, deps=rec.deps()) == "ready"
    run = maps.store.runs[attempt["id"]]
    assert (run.metrics.get("cacheHits"), run.metrics.get("modelCalls")) == (1, 1)
    # The first conversation once, the second twice (the failed call and this one).
    assert generation.model_calls[EXTRACT] == 3


@pytest.mark.asyncio
async def test_a_worker_that_dies_between_publication_and_enqueue_is_healed_by_the_minute_sweep(
    generation: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Breaks if the sweep stops claiming pending events whose after-commit
    message never went out, or publication stops writing the event row in its
    own transaction: the dependant would wait forever and the Map stay behind."""
    maps, rec = MapWorld(), Recorder()
    routes = _routes(monkeypatch, maps, rec)
    run_id = (await routes.generate()).json()["attempt"]["id"]
    dependant = await request_run(
        RunRequest(PROJECT, PAIRS_ON_ARGUMENTS, "project", idempotency_key="pairs"), store=maps.store, deps=rec.deps()
    )
    deps = rec.deps()

    def die(_event_id: str) -> None:
        raise WorkerDied()

    deps.enqueue_outbox = die
    with pytest.raises(WorkerDied):
        await run_worker(run_id, store=maps.store, deps=deps)

    # Committed, and nobody told.
    assert maps.store.runs[run_id].status == RunStatus.READY
    (event,) = [e for e in maps.store.outbox.values() if e.run_id == run_id]
    assert event.status == OutboxStatus.PENDING and event.attempts == 0
    assert maps.store.runs[dependant.run.id].status == RunStatus.WAITING_FOR_INPUTS
    assert maps.store.snapshots == {}

    report = await sweep(store=maps.store, deps=rec.outbox_deps(hooks=[map_view.map_view_hook]))
    assert report.events.delivered == 1 and maps.store.outbox[event.id].status == OutboxStatus.DELIVERED
    assert maps.store.runs[dependant.run.id].status == RunStatus.QUEUED
    assert rec.dispatched.count(dependant.run.id) == 1
    assert maps.current().source_event_id == event.id


# ── gaps: analysis runs and the Map ─────────────────────────────────────


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #2: a lapsed lease fails the run instead of re-queueing it")
@pytest.mark.asyncio
async def test_a_run_whose_worker_died_is_requeued_by_the_sweep_and_resumes_its_saved_steps(world: FixtureWorld) -> None:
    """A deploy kills the worker mid-run. The sweep that finds the lapsed lease
    queues the run again (it is below three attempts) and sends it to a
    worker, which resumes every step the dead one finished."""
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    calls: Counter[str] = Counter()

    async def die_on_the_second(label: str) -> None:
        calls[label] += 1
        if label == f"extract:{C2}" and calls[label] == 1:
            raise WorkerDied()

    world.during_model = die_on_the_second
    run_id = (await request_run(_words("k"), store=store, deps=rec.deps())).run.id
    with pytest.raises(WorkerDied):
        await run_worker(run_id, store=store, deps=rec.deps())
    orphan = store.runs[run_id]
    steps = {s.step_key: s.status for s in await store.get_steps(run_id)}
    given(orphan.status == RunStatus.RUNNING and orphan.attempt == 1, "the dead worker left its run running")
    given(steps == {f"extract:{C1}": StepStatus.COMPLETED, f"extract:{C2}": StepStatus.RUNNING}, "one step saved")

    store.clock.advance(DEFAULT_LEASE_SECONDS + 1)
    await sweep(store=store, deps=rec.outbox_deps())
    swept = store.runs[run_id]
    assert (swept.status, swept.error) == (RunStatus.QUEUED, None)
    if rec.dispatched.count(run_id) < 2:
        store.clock.advance(QUEUED_REDISPATCH_SECONDS + 1)
        await sweep(store=store, deps=rec.outbox_deps())
    assert rec.dispatched.count(run_id) == 2

    assert await run_worker(run_id, store=store, deps=rec.deps()) == "ready"
    resumed = store.runs[run_id]
    assert resumed.attempt == 2 and resumed.metrics["stepsResumed"] == 1
    assert calls == {f"extract:{C1}": 1, f"extract:{C2}": 2}


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #2: a lapsed lease fails the run instead of re-queueing it")
@pytest.mark.asyncio
async def test_a_run_whose_worker_dies_three_times_fails_after_its_third_lapsed_lease(world: FixtureWorld) -> None:
    """The attempt cap: re-queued after the first and second lapsed attempt,
    failed after the third, so a run that kills its worker cannot loop."""
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()

    async def always_die(label: str) -> None:
        if label == f"extract:{C2}":
            raise WorkerDied()

    world.during_model = always_die
    run_id = (await request_run(_words("k"), store=store, deps=rec.deps())).run.id
    after: list[RunStatus] = []
    for attempt in (1, 2, 3):
        with pytest.raises(WorkerDied):
            await run_worker(run_id, store=store, deps=rec.deps())
        store.clock.advance(DEFAULT_LEASE_SECONDS + 1)
        await sweep(store=store, deps=rec.outbox_deps())
        after.append(store.runs[run_id].status)
        if attempt < 3:
            assert after[-1] == RunStatus.QUEUED, after
    assert after == [RunStatus.QUEUED, RunStatus.QUEUED, RunStatus.FAILED]
    assert store.runs[run_id].attempt == 3


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #3: cancel is noticed only after the model call returns")
@pytest.mark.asyncio
async def test_cancelling_a_run_cancels_its_model_call_in_flight(world: FixtureWorld) -> None:
    """The keepalive that finds the run cancelled cancels the step's compute
    within its interval: the paid call does not run on to its end."""
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    deps = rec.deps()
    deps.keepalive_seconds = 0  # every turn of the loop is a keepalive interval
    run_id = (await request_run(_words("k"), store=store, deps=deps)).run.id
    call: dict[str, Any] = {}

    async def slow_call(label: str) -> None:
        if label != f"extract:{C1}":
            return
        await cancel_run(run_id, store=store, deps=deps)
        call["interrupted"] = False
        try:
            for turn in range(200):  # the provider taking its time
                await asyncio.sleep(0)
                call["turns"] = turn + 1
        except asyncio.CancelledError:
            call["interrupted"] = True
            raise
        call["finished"] = True

    world.during_model = slow_call
    stopped = await run_worker(run_id, store=store, deps=deps)
    given(store.runs[run_id].status == RunStatus.CANCELLED, "the run was cancelled")
    assert call.get("interrupted") is True and "finished" not in call, call
    assert stopped == "stopped" and world.model_calls[EXTRACT] == 1


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #3: a step is marked running before it has a model slot")
@pytest.mark.asyncio
async def test_a_step_waiting_for_a_model_slot_is_not_marked_running(world: FixtureWorld) -> None:
    """With one model slot, the second conversation's step takes the slot
    before its row says running (and before its keepalive starts), so a
    running step is one that is calling the model."""
    _seed(world)
    register_recipe(parallel_recipe(world), replace=True)
    try:
        store, rec = FakeAnalysisStore(), Recorder()
        run_id = (
            await request_run(RunRequest(PROJECT, PARALLEL, "project", idempotency_key="p"), store=store, deps=rec.deps())
        ).run.id
        seen: list[tuple[str, list[str]]] = []

        async def look(label: str) -> None:
            if seen:
                return
            for _ in range(20):  # let the other conversation get as far as it can
                await asyncio.sleep(0)
            running = sorted(s.step_key for s in store.steps.values() if s.status == StepStatus.RUNNING)
            seen.append((label, running))

        world.during_model = look
        given(await run_worker(run_id, store=store, deps=rec.deps()) == "ready", "the parallel run publishes")
        ((label, running),) = seen
        assert running == [label]
    finally:
        unregister_recipe(PARALLEL)


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #4: a chunk that lands after pinning fails the run and every retry")
@pytest.mark.asyncio
async def test_a_transcript_that_grows_while_the_run_is_queued_still_ends_in_a_ready_map() -> None:
    """People keep talking while a run is queued. The new chunk is either left
    out (the run reads exactly what it pinned) or picked up by the retry; it
    never fails the run and then every retry the same way.

    `test_recipe_arguments.py::test_a_transcript_that_changed_after_pinning_
    fails_the_run_before_any_call` locks in today's first failure; the fix
    that pins chunk ids replaces it, the one that re-resolves on retry keeps it."""
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    deps = world.deps(rec)
    request = RunRequest(DEBATE, "arguments", "project", idempotency_key="a1")
    run_id = (await request_run(request, store=store, deps=deps)).run.id
    bob = next(t for t in world.transcripts if t.id == BOB)
    world.set_text(BOB, bob.text + "\nBob: And the last bus leaves far too early.")

    status = await run_worker(run_id, store=store, deps=deps)
    if status == "failed":
        retry = await request_run(
            RunRequest(DEBATE, "arguments", "project", mode="retry", idempotency_key="r1"), store=store, deps=deps
        )
        status = await run_worker(retry.run.id, store=store, deps=deps)
    errors = sorted({run.error for run in store.runs.values() if run.error})
    assert status == "ready", (status, errors)


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #5: a refresh during a running run re-extracts what that run is extracting")
@pytest.mark.asyncio
async def test_a_refresh_during_a_running_run_waits_for_it_and_pays_only_for_the_new_conversation(world: FixtureWorld) -> None:
    """A conversation lands during a long run and someone presses refresh. The
    newcomer waits on the scope's running run and reuses its steps when it
    wakes (one running run per producer scope): each conversation is read
    once, and the output that ends current covers all three."""
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    calls: Counter[str] = Counter()
    newcomer: list[str] = []

    async def refresh_meanwhile(label: str) -> None:
        calls[label] += 1
        if label == f"extract:{C1}" and not newcomer:
            world.sources[PROJECT][C3] = ["Ferries are slow."]
            second = await request_run(_words("k2"), store=store, deps=rec.deps())
            newcomer.append(second.run.id)
            # A second worker takes whatever it was sent while the first extracts.
            await run_worker(second.run.id, store=store, deps=rec.deps())

    world.during_model = refresh_meanwhile
    first = await request_run(_words("k1"), store=store, deps=rec.deps())
    await run_worker(first.run.id, store=store, deps=rec.deps())
    await _drain(store, rec)

    given(len(newcomer) == 1, "the second refresh was requested")
    assert calls == {f"extract:{C1}": 1, f"extract:{C2}": 1, f"extract:{C3}": 1}
    current = store.runs[str(store.scopes[first.run.scope_id].current_run_id)]
    assert current.status == RunStatus.READY and len(current.output_manifest["objects"]) == 4  # type: ignore[index]


class _Checker:
    async def __call__(self, **_kwargs: Any) -> dict[str, Any]:
        return {"verdict": "false", "justification": "The fixture says so.", "sources": []}


async def _context(_project_id: str) -> tuple[str, str]:
    return "Harbour", "Trams or buses."


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #6: a verdict whose assessment write failed is never recorded")
@pytest.mark.asyncio
async def test_a_verdict_saved_without_its_assessment_is_recorded_by_the_minute_job(
    world: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The check committed its verdict, then recording it as an assessment
    failed (a database blip). The minute job (`task_analysis_outbox_dispatch`
    without an event, `outbox.run_dispatch()`) finds the done check without
    its `map-fact-check:{id}:{attempt}` run and records it, so the claim's
    assessment catches up without anyone paying for a second check."""
    maps, rec = MapWorld(), Recorder()

    async def quiet(_project_id: str, _event: dict[str, Any]) -> None:
        return None

    monkeypatch.setattr(service, "publish_map_event", quiet)
    monkeypatch.setattr(map_events, "publish_map_event", quiet)
    _seed(world)
    world.claims = {CLAIM}
    await inline(maps.store, WORDS, "seed")
    snapshot = await maps.advance()
    claim = next(
        r for r in maps.store.revisions.values() if r.status == RevisionStatus.PUBLISHED and r.payload["statement"] == CLAIM
    )
    jobs: list[tuple[Any, ...]] = []

    def dispatch(*job: Any) -> str:
        jobs.append(job)
        return "msg"

    await service.start_snapshot_fact_check(
        service.SnapshotTarget(snapshot),
        claim.id,
        requested_by="du1",
        force=False,
        store=maps.map_store,
        analysis_store=maps.store,
        dispatch=dispatch,
    )
    (job,) = jobs
    maps.store.raise_on["create_run"] = AnalysisStoreError("the database blinked")
    status = await fact_check.run_fact_check(
        *job,
        store=maps.map_store,
        check=_Checker(),
        project_context=_context,
        publish=maps.publish,
        redis=FakeAsyncRedis(),
        analysis_store=maps.store,
        reads=maps.reads,
        executor_deps=rec.deps(),
    )
    del maps.store.raise_on["create_run"]
    given(status == "done", "the verdict was saved")
    given(not [r for r in maps.store.revisions.values() if r.type == "fact_check_assessment"], "no assessment yet")

    # Every default the minute job builds points at this world.
    monkeypatch.setattr(outbox, "default_store", lambda: maps.store)
    monkeypatch.setattr(outbox, "default_deps", lambda *_a, **_k: rec.deps())
    monkeypatch.setattr(map_view, "default_reads", lambda: maps.reads)
    monkeypatch.setattr(fact_check, "default_store", lambda: maps.store)
    monkeypatch.setattr(fact_check, "default_deps", lambda *_a, **_k: rec.deps())
    monkeypatch.setattr(fact_check, "default_reads", lambda: maps.reads)
    monkeypatch.setattr(fact_check, "SqlMapStore", lambda *_a, **_k: maps.map_store)
    monkeypatch.setattr(map_store_module, "SqlMapStore", lambda *_a, **_k: maps.map_store)
    await outbox.run_dispatch()

    assessments = [
        r for r in maps.store.revisions.values() if r.type == "fact_check_assessment" and r.status == RevisionStatus.PUBLISHED
    ]
    assert [(a.payload["verdict"], a.provenance.input_revision_ids) for a in assessments] == [("false", (claim.id,))]


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"{REVIEW} #7: no recipe sets max_running")
@pytest.mark.parametrize("recipe_id", ["arguments", "deduplicated_arguments", "tensions"])
def test_a_heavy_map_producer_caps_how_many_of_its_runs_run_at_once(recipe_id: str) -> None:
    """A declaration, not a flow: what the cap does once set is covered by
    `test_executor.py::test_a_recipe_at_its_running_limit_defers_the_next_run`
    and, under contention in Postgres, by
    `test_second_review_sql.py::test_b11_concurrent_claims_respect_the_running_limit`."""
    assert get_recipe(recipe_id).max_running is not None


# ── gaps: cross-cutting ─────────────────────────────────────────────────


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="Review 2026-09-23 cross-cutting #5: the analysis sweep shares the ticks queue with hour-long runs")
def test_the_minute_analysis_sweep_does_not_queue_behind_the_runs_it_heals() -> None:
    """The scheduler's analysis sweep either runs in the scheduler process or
    is sent to a queue other than the one analysis runs (and popcorn ticks)
    hold for up to an hour, so four long jobs cannot hold back lease expiry,
    wake-ups and outbox redelivery."""
    import importlib

    from dembrane import tasks
    from dembrane.scheduler import scheduler

    jobs = [job for job in scheduler.get_jobs() if "analysis" in job.id and ("sweep" in job.id or "outbox" in job.id)]
    given(bool(jobs), "the scheduler has an analysis sweep job")
    for job in jobs:
        module_name, _sep, attribute = str(job.func_ref).partition(":")
        if not attribute.endswith(".send"):
            continue  # runs in the scheduler process itself
        actor = getattr(importlib.import_module(module_name), attribute.removesuffix(".send"))
        assert actor.queue_name != tasks.task_analysis_run.queue_name, (job.id, actor.queue_name)
