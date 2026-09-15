"""Reproductions of the second September 2026 review of the executor, outbox and
snapshots, against the in-memory store. Each failed on the code it reviewed."""

from __future__ import annotations

import uuid
from typing import Any, Iterator
from collections import Counter
from dataclasses import field, dataclass

import pytest

from dembrane.analysis import outbox
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.outbox import sweep, dispatch_events
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import (
    RunRequest,
    StepResult,
    RecipeContext,
    run_worker,
    request_run,
    execute_inline,
)
from dembrane.analysis.registry import (
    Recipe,
    StepDef,
    InputRequest,
    InvalidRecipeRequest,
    register_recipe,
    unregister_recipe,
)
from dembrane.analysis.contracts import (
    NewRun,
    RunMode,
    StepKind,
    RunStatus,
    ScopeKind,
    StepStatus,
    CheckStatus,
    OutboxEvent,
    CheckOutcome,
    AnalysisStore,
    RevisionStatus,
    SnapshotConflict,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import ProducerRef, SnapshotRequest, assemble_snapshot
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
PROBE = "fixture.probe"


@dataclass
class Knobs:
    version: str = "v1"
    answer: str = "first"
    fail_check: bool = False
    calls: Counter[str] = field(default_factory=Counter)
    seen: tuple[str, ...] = ()
    loud: str = ""


def _probe(knobs: Knobs, *, check_version: str = "1") -> Recipe:
    async def resolve(_request: InputRequest) -> dict[str, Any]:
        return {"version": knobs.version}

    async def execute(ctx: RecipeContext) -> None:
        async def model() -> StepResult:
            knobs.calls["model"] += 1
            return StepResult(output={"answer": knobs.answer}, model_calls=1)

        answer = await ctx.step("model", model, inputs={"text": "X"})

        def reader(who: str) -> Any:
            async def read() -> StepResult:
                knobs.calls["read"] += 1
                return StepResult(output={"who": who}, model_calls=1)

            return read

        first = await ctx.step("read", reader("A"), instance="A")
        second = await ctx.step("read", reader("B"), instance="B")
        knobs.seen = (first["who"], second["who"])

        async def shout() -> StepResult:
            knobs.calls["shout"] += 1
            return StepResult(output={"loud": answer["answer"].upper()})

        knobs.loud = (await ctx.step("shout", shout))["loud"]

        async def check() -> StepResult:
            knobs.calls["check"] += 1
            status = CheckStatus.FAILED if knobs.fail_check else CheckStatus.PASSED
            return StepResult(output={"ok": not knobs.fail_check}, validation=(CheckOutcome("probe", status),))

        await ctx.step("check", check, inputs={"fixed": 1})
        await ctx.emit("argument", "probe", {"statement": f"{knobs.loud} {ctx.input_manifest['version']}", "epistemicKind": "argument"})

    return Recipe(
        id=PROBE,
        version="1",
        name="Probe",
        purpose="Exercises step cache keys.",
        input_types=(),
        steps=(
            StepDef("model", "1", StepKind.MODEL, "Answer", prompt_ref="probe/model", prompt_version="1"),
            StepDef("read", "1", StepKind.MODEL, "Read one", prompt_ref="probe/read", prompt_version="1"),
            StepDef("shout", "1", StepKind.DETERMINISTIC, "Upper-case the answer"),
            StepDef("check", "1", StepKind.CHECK, "Check the answer", check_version=check_version),
        ),
        output_types=("argument",),
        execute=execute,
        resolve_inputs=resolve,
    )


@pytest.fixture
def knobs() -> Iterator[Knobs]:
    state = Knobs()
    register_recipe(_probe(state), replace=True)
    try:
        yield state
    finally:
        unregister_recipe(PROBE)


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


def _request(recipe: str = PROBE, **kwargs: Any) -> RunRequest:
    return RunRequest(project_id=PROJECT, recipe_id=recipe, scope_key=kwargs.pop("scope_key", "project"), **kwargs)


async def _ready(store: FakeAnalysisStore, rec: Recorder, request: RunRequest) -> str:
    outcome = await request_run(request, store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    return outcome.run.id


# ── B1 step cache keys ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b1_explicit_inputs_do_not_hide_a_changed_global_input(knobs: Knobs) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(idempotency_key="k1"))
    knobs.version = "v2"
    await _ready(store, rec, _request(idempotency_key="k2"))
    assert knobs.calls["model"] == 2


@pytest.mark.asyncio
async def test_b1_two_instances_without_inputs_do_not_share_an_answer(knobs: Knobs) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(idempotency_key="k1"))
    assert knobs.seen == ("A", "B") and knobs.calls["read"] == 2


@pytest.mark.asyncio
async def test_b1_a_deterministic_step_after_a_regenerated_model_step_recomputes(knobs: Knobs) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(idempotency_key="k1"))
    assert knobs.loud == "FIRST"
    knobs.answer = "second"
    await _ready(store, rec, _request(mode="regenerate", idempotency_key="g1"))
    assert knobs.loud == "SECOND"


@pytest.mark.asyncio
async def test_b1_caller_context_cannot_replace_the_model_configuration(knobs: Knobs) -> None:  # noqa: ARG001
    with pytest.raises(InvalidRecipeRequest, match="reserved"):
        await request_run(_request(context={"model": {"model": "cheaper"}}), store=FakeAnalysisStore(), deps=Recorder().deps())


# ── B2 whole-output reuse ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b2_a_changed_check_definition_is_not_reused(knobs: Knobs) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(idempotency_key="k1"))
    register_recipe(_probe(knobs, check_version="2"), replace=True)
    outcome = await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())
    assert outcome.outcome == "created"


@pytest.mark.asyncio
async def test_b2_an_edited_head_is_not_reused_as_the_ready_output(knobs: Knobs) -> None:  # noqa: ARG001
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(idempotency_key="k1"))
    (head,) = [v for v in store.revisions.values() if v.status == RevisionStatus.PUBLISHED]
    await RevisionService(store).author_edit(
        project_id=PROJECT,
        object_id=head.object_id,
        expected_revision_id=head.id,
        payload={**head.payload, "statement": "Edited by hand."},
        actor_id="u1",
    )
    outcome = await request_run(_request(idempotency_key="k2"), store=store, deps=rec.deps())
    assert outcome.outcome != "reused"


# ── B3 dependency compatibility ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_b3_an_incompatible_ready_dependency_is_not_pinned(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    await execute_inline(_request(WORDS, idempotency_key="w1"), store=store, deps=rec.deps())
    outcome = await request_run(_request(PAIRS, idempotency_key="p1", context={"voice": "b"}), store=store, deps=rec.deps())
    assert len(outcome.dependencies) == 1 and outcome.run.status == RunStatus.WAITING_FOR_INPUTS


def _new(project: str, scope_id: str, recipe: str, key: str, **overrides: Any) -> NewRun:
    base: dict[str, Any] = dict(
        project_id=project,
        scope_id=scope_id,
        recipe_id=recipe,
        recipe_version="1",
        definition={"id": recipe, "version": "1", "steps": []},
        mode=RunMode.REFRESH,
        idempotency_key=key,
        request_fingerprint=content_hash(key),
        status=RunStatus.QUEUED,
        epoch=0,
        input_manifest={"revisionIds": []},
        input_fingerprint=content_hash({"revisionIds": []}),
    )
    base.update(overrides)
    return NewRun(**base)


def _manifest(run: Any) -> dict[str, Any]:
    return {"objects": [], "relations": [], "inputs": {"fingerprint": run.input_fingerprint, "revisionIds": [], "dependencies": {}}}


@pytest.mark.asyncio
async def test_b3_a_superseded_dependency_is_not_replaced_by_an_incompatible_one() -> None:
    store = FakeAnalysisStore()
    dep = await store.ensure_scope(project_id=PROJECT, kind=ScopeKind.PRODUCER, owner_id="fixture.dep", scope_key="project")
    parent = await store.ensure_scope(project_id=PROJECT, kind=ScopeKind.PRODUCER, owner_id="fixture.parent", scope_key="project")
    d1, _ = await store.create_run(_new(PROJECT, dep.id, "fixture.dep", "d1", context={"voice": "a"}))
    d2, _ = await store.create_run(_new(PROJECT, dep.id, "fixture.dep", "d2", context={"voice": "b"}))
    for run in (d1, d2):
        assert (await store.claim_run(run.id, f"lease-{run.id}", max_running=None)).outcome == "claimed"
    assert (await store.publish_run(d2.id, f"lease-{d2.id}", manifest=_manifest(d2), checks=[], metrics={})).outcome == "ready"
    assert (await store.publish_run(d1.id, f"lease-{d1.id}", manifest=_manifest(d1), checks=[], metrics={})).outcome == "superseded"
    waiter, _ = await store.create_run(
        _new(PROJECT, parent.id, "fixture.parent", "w", status=RunStatus.WAITING_FOR_INPUTS, depends_on=(d1.id,), input_manifest=None, input_fingerprint=None)
    )
    await store.wake_waiting_runs(PROJECT)
    assert (await store.get_run(waiter.id)).status == RunStatus.FAILED  # type: ignore[union-attr]


# ── B4 retry keys ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_b4_retry_never_answers_with_an_equivalent_active_run(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    world.fail_conversations = {C2}
    failed = await request_run(_request(WORDS, idempotency_key="k1"), store=store, deps=rec.deps())
    assert await run_worker(failed.run.id, store=store, deps=rec.deps()) == "failed"
    world.fail_conversations = set()
    active = await request_run(_request(WORDS, idempotency_key="k2"), store=store, deps=rec.deps())
    assert active.outcome == "created" and active.run.id != failed.run.id

    with pytest.raises(Exception, match="in flight"):
        await request_run(_request(WORDS, mode="retry", idempotency_key="retry"), store=store, deps=rec.deps())
    assert await store.run_by_idempotency_key(PROJECT, "retry") is None
    assert (await store.get_run(failed.run.id)).status == RunStatus.FAILED  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_b4_an_accepted_key_is_answered_before_mutable_validation(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    await execute_inline(_request(WORDS, idempotency_key="w1"), store=store, deps=rec.deps())
    selected = next(iter(store.revisions))
    first = await request_run(_request(PAIRS, idempotency_key="p", selected_revision_ids=(selected,)), store=store, deps=rec.deps())
    store.revisions.pop(selected)
    again = await request_run(_request(PAIRS, idempotency_key="p", selected_revision_ids=(selected,)), store=store, deps=rec.deps())
    assert again.run.id == first.run.id and again.outcome == "existing"


# ── B5 failed validation artifacts ──────────────────────────────────────


@pytest.mark.asyncio
async def test_b5_a_step_whose_check_failed_is_saved_failed_and_recomputed_on_retry(knobs: Knobs) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    knobs.fail_check = True
    outcome = await request_run(_request(idempotency_key="k1"), store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "failed"
    (check,) = [s for s in await store.get_steps(outcome.run.id) if s.step_key == "check"]
    assert check.status == StepStatus.FAILED and check.validation[0]["status"] == "failed" and check.output == {"ok": False}

    knobs.fail_check = False
    await request_run(_request(mode="retry", idempotency_key="r1"), store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    assert knobs.calls["check"] == 2


# ── B8 embedding configuration on reuse ─────────────────────────────────


@pytest.mark.asyncio
async def test_b8_a_changed_embedding_configuration_is_not_discarded_by_reuse(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    await _ready(store, rec, _request(WORDS, idempotency_key="k1"))
    world.dims = 5
    run_id = await _ready(store, rec, _request(WORDS, mode="regenerate", idempotency_key="g1"))
    run = await store.get_run(run_id)
    assert run is not None and run.metrics.get("objectsStaged") == 3
    heads = [store.revisions[o.current_revision_id] for o in store.objects.values()]  # type: ignore[index]
    assert {h.embedding_refs["configKey"] for h in heads} == {world.identity().key}  # type: ignore[index]


# ── B10 no-op upstream refresh ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_b10_a_no_op_upstream_refresh_leaves_the_downstream_output_reusable(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    await execute_inline(_request(PAIRS, idempotency_key="p1"), store=store, deps=rec.deps())
    words = await request_run(_request(WORDS, idempotency_key="w2"), store=store, deps=rec.deps())
    assert words.outcome == "reused"
    pairs = await request_run(_request(PAIRS, idempotency_key="p2"), store=store, deps=rec.deps())
    assert pairs.outcome == "reused" and world.model_calls[f"{PAIRS}:pair"] == 1


# ── B12 identical snapshot content ──────────────────────────────────────


@pytest.mark.asyncio
async def test_b12_identical_content_still_detects_a_moved_view(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    await execute_inline(_request(WORDS, idempotency_key="w1"), store=store, deps=rec.deps())
    view = SnapshotRequest(PROJECT, "map", "project", (ProducerRef(WORDS, "project"),))
    first = await assemble_snapshot(view, store=store)
    await assemble_snapshot(SnapshotRequest(PROJECT, "map", "project", view.producers, settings={"colorBy": "type"}), store=store)
    with pytest.raises(SnapshotConflict):
        await assemble_snapshot(view, store=store, expected_previous_id=first.id)


# ── outbox consumers ────────────────────────────────────────────────────


async def _published_words(world: FixtureWorld, store: FakeAnalysisStore, rec: Recorder) -> OutboxEvent:
    _seed(world)
    run_id = await _ready(store, rec, _request(WORDS, idempotency_key=str(uuid.uuid4())))
    (event,) = [e for e in store.outbox.values() if e.run_id == run_id]
    return event


@pytest.mark.asyncio
async def test_a_failing_consumer_does_not_block_the_others(world: FixtureWorld) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    event = await _published_words(world, store, rec)
    calls: Counter[str] = Counter()

    async def broken(_event: OutboxEvent, _store: AnalysisStore, _deps: Any) -> None:
        raise RuntimeError("down")

    async def counted(_event: OutboxEvent, _store: AnalysisStore, _deps: Any) -> None:
        calls["counted"] += 1

    await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=(("broken", broken), ("counted", counted)))
    assert calls["counted"] == 1 and set(store.outbox[event.id].consumers) == {"counted"}


@pytest.mark.asyncio
async def test_the_sweep_finishes_snapshot_effects_of_a_dead_event(world: FixtureWorld, monkeypatch: pytest.MonkeyPatch) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    event = await _published_words(world, store, rec)
    monkeypatch.setattr(outbox, "MAX_ATTEMPTS", 1)
    calls: Counter[str] = Counter()

    async def hook(_event: OutboxEvent, _store: AnalysisStore) -> None:
        calls["hook"] += 1
        if calls["hook"] == 1:
            raise RuntimeError("assembly failed once")

    deps = rec.outbox_deps(hooks=[hook])
    await dispatch_events(store=store, deps=deps)
    assert store.outbox[event.id].status == "dead"
    store.clock.advance(3601)
    await sweep(store=store, deps=deps)
    assert calls["hook"] == 2 and "view_snapshots" in store.outbox[event.id].consumers
