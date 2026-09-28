"""The executor against the in-memory store, with the fixture recipes."""

from __future__ import annotations

from dataclasses import replace

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.outbox import dispatch_events
from dembrane.analysis.planner import DependencyCycle
from dembrane.analysis.executor import (
    RunRequest,
    cancel_run,
    run_worker,
    request_run,
    execute_inline,
)
from dembrane.analysis.registry import (
    UnknownRecipe,
    InvalidRecipeRequest,
    get_recipe,
    register_recipe,
)
from dembrane.analysis.contracts import RunStatus, StepStatus, RevisionStatus, RevisionConflict
from dembrane.analysis.revisions import RevisionService
from tests.analysis.fixture_recipes import PAIRS, WORDS, CYCLE_A, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


def _request(recipe: str = WORDS, scope_key: str = "project", **kwargs: object) -> RunRequest:
    return RunRequest(project_id=PROJECT, recipe_id=recipe, scope_key=scope_key, **kwargs)  # type: ignore[arg-type]


async def _ready(store: FakeAnalysisStore, rec: Recorder, request: RunRequest) -> str:
    outcome = await request_run(request, store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    return outcome.run.id


@pytest.mark.asyncio
async def test_a_run_publishes_its_objects_checks_and_an_outbox_event(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    seen_before_publication: list[tuple[str | None, set[str]]] = []

    async def look(ctx: object) -> None:
        scope = next(iter(store.scopes.values()))
        seen_before_publication.append((scope.current_run_id, {str(v.status) for v in store.revisions.values()}))

    world.after_emit = look  # type: ignore[assignment]
    outcome = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    assert outcome.outcome == "created" and outcome.run.status == RunStatus.QUEUED
    assert rec.dispatched == [outcome.run.id]
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"

    # Staged rows were invisible: no current run, nothing published.
    assert seen_before_publication == [(None, {"staged"})]
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.status == RunStatus.READY and run.output_manifest is not None
    assert len(run.output_manifest["objects"]) == 3 and run.output_manifest["relations"] == []
    assert {c["check"] for c in run.checks} >= {"schema", "references", "embeddings-durable", "statements-have-text"}
    assert run.metrics["modelCalls"] == 2 and run.metrics["objectsStaged"] == 3 and "cacheHits" not in run.metrics
    assert (await store.get_scope(run.scope_id)).current_run_id == run.id  # type: ignore[union-attr]
    published = [v for v in store.revisions.values() if v.status == RevisionStatus.PUBLISHED]
    assert len(published) == 3 and all(store.objects[v.object_id].current_revision_id == v.id for v in published)
    events = [e for e in store.outbox.values() if e.run_id == run.id]
    assert [e.event_type for e in events] == ["run_published"] and rec.enqueued == [events[0].id]
    steps = await store.get_steps(run.id)
    assert sorted(s.step_key for s in steps) == ["check", f"extract:{C1}", f"extract:{C2}"]
    assert all(s.status == StepStatus.COMPLETED for s in steps)
    assert next(s for s in steps if s.step_key == f"extract:{C1}").output == {"items": ["Trams are better.", "Buses are cheaper."]}
    assert rec.event_types()[-1] == "ready"


@pytest.mark.asyncio
async def test_unknown_recipes_invalid_scopes_and_cycles_fail_before_anything_is_written(world: FixtureWorld) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    with pytest.raises(UnknownRecipe):
        await request_run(_request("fixture.nope"), store=store, deps=rec.deps())
    with pytest.raises(InvalidRecipeRequest):
        await request_run(_request(scope_key="everywhere"), store=store, deps=rec.deps())
    with pytest.raises(InvalidRecipeRequest):
        await request_run(_request(mode="rerun"), store=store, deps=rec.deps())
    with pytest.raises(DependencyCycle) as cycle:
        await request_run(_request(CYCLE_A), store=store, deps=rec.deps())
    assert cycle.value.path[0] == cycle.value.path[-1] == f"{CYCLE_A}@project"
    assert store.scopes == {} and store.runs == {} and rec.events == [] and world.total_model_calls() == 0


@pytest.mark.asyncio
async def test_the_same_key_returns_the_same_run_and_equivalent_work_is_shared(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    again = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    joined = await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())
    assert again.run.id == joined.run.id == first.run.id
    assert (again.outcome, joined.outcome) == ("existing", "existing")
    assert len(store.runs) == 1 and rec.dispatched == [first.run.id]
    await run_worker(first.run.id, store=store, deps=rec.deps())
    assert (await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())).run.id == first.run.id


@pytest.mark.asyncio
async def test_a_refresh_with_unchanged_inputs_reuses_the_output_and_calls_no_model(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first_id = await _ready(store, rec, _request(idempotency_key="k1"))
    calls, embeds = world.total_model_calls(), len(world.embed_calls)

    reuse = await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())
    assert reuse.outcome == "reused" and reuse.run.status == RunStatus.READY
    assert reuse.run.reused_run_id == first_id and reuse.run.metrics["reuse"] == "output"
    assert world.total_model_calls() == calls and len(world.embed_calls) == embeds
    assert rec.dispatched == [first_id]
    first = await store.get_run(first_id)
    assert reuse.run.output_manifest == first.output_manifest  # type: ignore[union-attr]
    assert (await store.get_scope(reuse.run.scope_id)).current_run_id == reuse.run.id  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_a_changed_conversation_recomputes_only_its_own_stage(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first_id = await _ready(store, rec, _request(idempotency_key="k1"))
    first = await store.get_run(first_id)
    world.sources[PROJECT][C2] = ["Bikes are healthy and quick."]

    second_id = await _ready(store, rec, _request(idempotency_key="k2"))
    second = await store.get_run(second_id)
    assert second is not None and first is not None
    assert world.model_calls[f"{WORDS}:extract"] == 3
    assert second.metrics["cacheHits"] == 1 and second.metrics["modelCalls"] == 1
    assert second.metrics["objectsReused"] == 2 and second.metrics["objectsStaged"] == 1
    assert world.embed_calls[-1] == "Bikes are healthy and quick." and len(world.embed_calls) == 4
    # The changed statement is a new revision of the same object.
    before = {o["objectId"]: o["revisionId"] for o in first.output_manifest["objects"]}  # type: ignore[index]
    after = {o["objectId"]: o["revisionId"] for o in second.output_manifest["objects"]}  # type: ignore[index]
    assert before.keys() == after.keys() and sum(before[k] != after[k] for k in before) == 1


@pytest.mark.asyncio
async def test_regenerate_returns_its_run_for_its_key_and_a_new_epoch_for_a_new_key(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first_id = await _ready(store, rec, _request(idempotency_key="k1"))
    embeds = len(world.embed_calls)

    regenerate = await request_run(_request(mode="regenerate", idempotency_key="g1"), store=store, deps=rec.deps())
    repeated = await request_run(_request(mode="regenerate", idempotency_key="g1"), store=store, deps=rec.deps())
    assert repeated.run.id == regenerate.run.id and regenerate.run.epoch == 1
    assert await run_worker(regenerate.run.id, store=store, deps=rec.deps()) == "ready"
    assert world.model_calls[f"{WORDS}:extract"] == 4
    assert len(world.embed_calls) == embeds  # identical statements reuse their vectors
    run = await store.get_run(regenerate.run.id)
    assert run is not None and run.metrics["objectsReused"] == 3 and run.id != first_id

    newer = await request_run(_request(mode="regenerate", idempotency_key="g2"), store=store, deps=rec.deps())
    assert newer.outcome == "created" and newer.run.epoch == 2


@pytest.mark.asyncio
async def test_retry_resumes_the_failed_run_with_its_saved_steps_under_a_new_lease(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    world.fail_conversations = {C2}
    outcome = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "failed"
    failed = await store.get_run(outcome.run.id)
    assert failed is not None and failed.status == RunStatus.FAILED and failed.error == "Running the recipe failed."
    steps = {s.step_key: s.status for s in await store.get_steps(failed.id)}
    assert steps == {f"extract:{C1}": StepStatus.COMPLETED, f"extract:{C2}": StepStatus.FAILED}

    world.fail_conversations = set()
    retry = await request_run(_request(mode="retry", idempotency_key="r1"), store=store, deps=rec.deps())
    assert retry.outcome == "requeued" and retry.run.id == failed.id
    assert (await request_run(_request(mode="retry", idempotency_key="r1"), store=store, deps=rec.deps())).run.id == failed.id
    assert await run_worker(failed.id, store=store, deps=rec.deps()) == "ready"
    run = await store.get_run(failed.id)
    assert run is not None and run.attempt == 2 and run.lease != failed.lease
    assert world.model_calls[f"{WORDS}:extract"] == 3 and run.metrics["stepsResumed"] == 1


@pytest.mark.asyncio
async def test_a_waiting_run_wakes_on_its_dependencys_publication_and_pins_that_manifest(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(_request(PAIRS, idempotency_key="p1"), store=store, deps=rec.deps())
    (words_run,) = outcome.dependencies
    assert outcome.run.status == RunStatus.WAITING_FOR_INPUTS and outcome.run.depends_on == [words_run.id]
    assert words_run.status == RunStatus.QUEUED and rec.dispatched == [words_run.id]

    assert await run_worker(words_run.id, store=store, deps=rec.deps()) == "ready"
    assert (await dispatch_events(store=store, deps=rec.outbox_deps())).delivered == 1
    woken = await store.get_run(outcome.run.id)
    assert woken is not None and woken.status == RunStatus.QUEUED and rec.dispatched[-1] == woken.id

    assert await run_worker(woken.id, store=store, deps=rec.deps()) == "ready"
    pairs = await store.get_run(woken.id)
    words = await store.get_run(words_run.id)
    assert pairs is not None and words is not None
    pinned = pairs.input_manifest["dependencies"]["arguments"]  # type: ignore[index]
    assert pinned["runId"] == words.id and pinned["manifestHash"] == words.output_manifest["contentHash"]  # type: ignore[index]
    argument_revisions = {o["revisionId"] for o in words.output_manifest["objects"]}  # type: ignore[index]
    relations = pairs.output_manifest["relations"]  # type: ignore[index]
    assert sorted(r["type"] for r in relations) == ["supports_pole_a", "supports_pole_b"]
    assert all(r["from"] in argument_revisions for r in relations)


@pytest.mark.asyncio
async def test_cancelling_stops_the_worker_at_its_next_checkpoint(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())

    async def cancel(label: str) -> None:
        if label == f"extract:{C1}":
            await cancel_run(outcome.run.id, store=store, deps=rec.deps())

    world.during_model = cancel
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "stopped"
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.status == RunStatus.CANCELLED
    assert not store.revisions and (await store.get_scope(run.scope_id)).current_run_id is None  # type: ignore[union-attr]
    assert world.model_calls[f"{WORDS}:extract"] == 1


@pytest.mark.asyncio
async def test_a_failed_run_leaves_the_ready_output_and_another_scope_untouched(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    c1_id = await _ready(store, rec, _request(scope_key=f"conversation:{C1}", idempotency_key="c1"))
    c2_id = await _ready(store, rec, _request(scope_key=f"conversation:{C2}", idempotency_key="c2"))
    heads = {o.id: o.current_revision_id for o in store.objects.values()}

    world.sources[PROJECT][C2] = ["   "]  # a statement the argument schema refuses
    broken = await request_run(_request(scope_key=f"conversation:{C2}", idempotency_key="c2b"), store=store, deps=rec.deps())
    assert await run_worker(broken.run.id, store=store, deps=rec.deps()) == "failed"
    failed = await store.get_run(broken.run.id)
    assert failed is not None and failed.error == "The recipe produced output it may not publish."
    assert {s.id: s.current_run_id for s in store.scopes.values()} == {
        (await store.get_run(c1_id)).scope_id: c1_id,  # type: ignore[union-attr]
        (await store.get_run(c2_id)).scope_id: c2_id,  # type: ignore[union-attr]
    }
    assert {o.id: o.current_revision_id for o in store.objects.values()} == heads


@pytest.mark.parametrize("point", ["publish:locked", "publish:validated", "publish:heads", "publish:outbox"])
@pytest.mark.asyncio
async def test_a_crash_inside_publication_changes_nothing(world: FixtureWorld, point: str) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first_id = await _ready(store, rec, _request(idempotency_key="k1"))
    heads = {o.id: o.current_revision_id for o in store.objects.values()}
    events = dict(store.outbox)
    world.sources[PROJECT][C2] = ["Bikes are healthy and quick."]

    def crash(at: str) -> None:
        if at == point:
            raise RuntimeError(f"crashed at {at}")

    store.fault = crash
    second = await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())
    assert await run_worker(second.run.id, store=store, deps=rec.deps()) == "failed"
    run = await store.get_run(second.run.id)
    assert run is not None and run.status == RunStatus.FAILED
    assert (await store.get_scope(run.scope_id)).current_run_id == first_id  # type: ignore[union-attr]
    assert {o.id: o.current_revision_id for o in store.objects.values()} == heads
    assert store.outbox.keys() == events.keys()
    assert [v.status for v in store.revisions.values() if v.run_id == run.id] == [RevisionStatus.STAGED]


@pytest.mark.asyncio
async def test_a_generated_update_over_an_authored_head_keeps_the_authored_head(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    first_id = await _ready(store, rec, _request(idempotency_key="k1"))
    target = next(v for v in store.revisions.values() if v.payload["statement"] == "Trams are better.")
    edits = RevisionService(store)
    edited = await edits.author_edit(
        project_id=PROJECT,
        object_id=target.object_id,
        expected_revision_id=target.id,
        payload={**target.payload, "statement": "Trams are much better."},
        actor_id="u1",
        reason="clarity",
    )
    with pytest.raises(RevisionConflict) as conflict:
        await edits.author_edit(
            project_id=PROJECT, object_id=target.object_id, expected_revision_id=target.id, payload=target.payload, actor_id="u2"
        )
    assert conflict.value.current is not None and conflict.value.current.id == edited.id
    assert [e.event_type for e in store.outbox.values()].count("revision_published") == 1

    regenerate = await request_run(_request(mode="regenerate", idempotency_key="g1"), store=store, deps=rec.deps())
    assert await run_worker(regenerate.run.id, store=store, deps=rec.deps()) == "ready"
    run = await store.get_run(regenerate.run.id)
    assert run is not None and run.status == RunStatus.READY and run.id != first_id
    assert store.objects[target.object_id].current_revision_id == edited.id
    assert (await store.get_scope(run.scope_id)).current_run_id == run.id  # type: ignore[union-attr]
    assert {o["revisionId"] for o in run.output_manifest["objects"] if o["objectId"] == target.object_id} == {edited.id}  # type: ignore[index]
    assert [v for v in store.revisions.values() if v.run_id == run.id and v.object_id == target.object_id] == []


@pytest.mark.asyncio
async def test_a_worker_whose_lease_lapsed_is_replaced_and_cannot_publish(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    claim = await store.claim_run(outcome.run.id, "quiet-worker", max_running=None)
    assert claim.outcome == "claimed"
    store.clock.advance(21 * 60)
    assert await store.heartbeat_run(outcome.run.id, "quiet-worker", {}) is False

    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    stale = await store.publish_run(outcome.run.id, "quiet-worker", manifest={}, checks=[], metrics={})
    assert stale.outcome == "inactive"


@pytest.mark.asyncio
async def test_inline_execution_runs_dependencies_first_without_dispatching(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await execute_inline(_request(PAIRS, idempotency_key="i1"), store=store, deps=rec.deps())
    assert outcome.run.status == RunStatus.READY and rec.dispatched == []
    assert {r.recipe_id: r.status for r in store.runs.values()} == {WORDS: RunStatus.READY, PAIRS: RunStatus.READY}


@pytest.mark.asyncio
async def test_a_recipe_at_its_running_limit_defers_the_next_run(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    register_recipe(replace(get_recipe(WORDS), max_running=1), replace=True)
    first = await request_run(_request(scope_key=f"conversation:{C1}", idempotency_key="a"), store=store, deps=rec.deps())
    second = await request_run(_request(scope_key=f"conversation:{C2}", idempotency_key="b"), store=store, deps=rec.deps())
    assert (await store.claim_run(first.run.id, "busy-worker", max_running=1)).outcome == "claimed"

    assert await run_worker(second.run.id, store=store, deps=rec.deps()) == "deferred"
    assert rec.deferred == [(second.run.id, 30_000)]
    assert (await store.get_run(second.run.id)).status == RunStatus.QUEUED  # type: ignore[union-attr]
