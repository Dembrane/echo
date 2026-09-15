"""The spec's failure and reconstruction table, one test per row.

These run the real registered producers (arguments, deduplicated arguments,
tensions) and the integration fixture through the executor with scripted models,
at the producer and API level. The foundation's own unit and SQL tests cover the
store's internals; what is asserted here is the behaviour the table promises
when a recipe, a worker or a source fails.

Row order follows the table in
`docs/superpowers/specs/2026-09-15-analysis-objects-and-mixed-map.md`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.map.events as map_events
from dembrane.map import service
from tests.map_fakes import FakeAsyncRedis
from dembrane.analysis import types
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.map.fact_check import run_fact_check
from dembrane.analysis.outbox import dispatch_events
from dembrane.analysis.budgets import Ceilings, resolve_budgets
from dembrane.analysis.recipes import integration_fixture as delivery
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.map_view import GraphQuery, graph_payload, pinned_lineage
from dembrane.analysis.registry import register_recipe, unregister_recipe
from dembrane.analysis.contracts import Run, RunStatus, RevisionStatus, RevisionConflict
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import ProducerRef, SnapshotRequest, read_snapshot, build_manifest
from tests.analysis.map_v2_fakes import MapWorld
from tests.analysis.producer_fakes import (
    C1,
    C3,
    BRIDGE,
    PROJECT,
    RECORDINGS,
    MERGED_RECORD,
    ProducerWorld,
    item,
    planar,
    merge_all,
)

CHAIN = ("arguments", "deduplicated_arguments", "tensions")


@pytest.fixture(autouse=True)
def _quiet_map_events(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _publish(project_id: str, event: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(service, "publish_map_event", _publish)
    monkeypatch.setattr(map_events, "publish_map_event", _publish)


def _request(recipe: str, key: str, **kwargs: Any) -> RunRequest:
    parameters = kwargs.pop("parameters", None)
    if parameters is None:
        parameters = {"input_set": "deduplicated_arguments"} if recipe == "tensions" else {}
    return RunRequest(PROJECT, recipe, "project", parameters=parameters, idempotency_key=key, **kwargs)


async def _current(store: FakeAnalysisStore, recipe: str) -> Run:
    scope = await store.find_scope(project_id=PROJECT, kind="producer", owner_id=recipe, scope_key="project")  # type: ignore[arg-type]
    assert scope is not None and scope.current_run_id is not None
    run = await store.get_run(scope.current_run_id)
    assert run is not None
    return run


async def _chain(store: FakeAnalysisStore, world: ProducerWorld, rec: Recorder) -> dict[str, Run]:
    """Request tensions once, then work the queue as the workers and the outbox
    dispatcher would."""
    world.verifier = merge_all(MERGED_RECORD)
    deps = world.deps(rec)
    outcome = await request_run(_request("tensions", "chain"), store=store, deps=deps)
    arguments, dedup = outcome.dependencies
    for run_id in (arguments.id, dedup.id, outcome.run.id):
        assert await run_worker(run_id, store=store, deps=deps) == "ready"
        await dispatch_events(store=store, deps=rec.outbox_deps())
    return {recipe: await _current(store, recipe) for recipe in CHAIN}


def _snapshot_request() -> SnapshotRequest:
    return SnapshotRequest(
        project_id=PROJECT,
        view_id="map",
        scope_key="project",
        producers=tuple(ProducerRef(recipe_id=recipe, scope_key="project") for recipe in CHAIN),
    )


def _published(store: FakeAnalysisStore, type_id: str) -> list[Any]:
    return [
        r
        for r in store.revisions.values()
        if r.type == type_id and r.status == RevisionStatus.PUBLISHED
    ]


# ── row 1: repeat Refresh with unchanged inputs ─────────────────────────


@pytest.mark.asyncio
async def test_row_repeat_refresh_reuses_artifacts_and_calls_no_model() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    runs = await _chain(store, world, rec)
    calls, embeds = world.model_calls(), len(world.embed_calls)

    for recipe in CHAIN:
        outcome = await request_run(_request(recipe, f"again-{recipe}"), store=store, deps=world.deps(rec))
        assert outcome.outcome == "reused", recipe
        assert outcome.run.reused_run_id == runs[recipe].id
        assert outcome.run.output_manifest == runs[recipe].output_manifest
        assert outcome.run.metrics["modelCalls"] == 0

    assert world.model_calls() == calls and len(world.embed_calls) == embeds


# ── row 2: repeat transport request for Regenerate ──────────────────────


@pytest.mark.asyncio
async def test_row_a_repeated_regenerate_request_returns_its_run_and_a_new_one_opens_an_epoch() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    runs = await _chain(store, world, rec)
    embeds, extractions = len(world.embed_calls), sum(world.extract_calls.values())

    first = await request_run(_request("arguments", "g1", mode="regenerate"), store=store, deps=world.deps(rec))
    again = await request_run(_request("arguments", "g1", mode="regenerate"), store=store, deps=world.deps(rec))
    assert again.run.id == first.run.id and again.outcome == "existing"
    assert first.run.epoch == runs["arguments"].epoch + 1

    assert await run_worker(first.run.id, store=store, deps=world.deps(rec)) == "ready"
    # A new epoch asks the model again, and the identical statements reuse
    # their stored vectors rather than being embedded a second time.
    assert sum(world.extract_calls.values()) == extractions + 3
    assert len(world.embed_calls) == embeds

    newer = await request_run(_request("arguments", "g2", mode="regenerate"), store=store, deps=world.deps(rec))
    assert newer.outcome == "created" and newer.run.epoch == first.run.epoch + 1


# ── row 3: crash after saved extraction or embedding ────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["extraction", "judgement"])
async def test_row_retry_resumes_saved_stages_and_the_former_worker_cannot_publish(stage: str) -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    deps = world.deps(rec)
    if stage == "extraction":
        recipe, key = "arguments", "a1"
        world.fail_extract = {C3}
        target = await request_run(_request(recipe, key), store=store, deps=deps)
        run_id = target.run.id
    else:
        recipe = "tensions"
        world.verifier = merge_all(MERGED_RECORD)
        outcome = await request_run(_request(recipe, "t1"), store=store, deps=deps)
        arguments, dedup = outcome.dependencies
        for ready in (arguments.id, dedup.id):
            assert await run_worker(ready, store=store, deps=deps) == "ready"
            await dispatch_events(store=store, deps=rec.outbox_deps())
        world.judge_errors["write"] = ValueError("the fake judge answered badly")
        run_id = outcome.run.id

    assert await run_worker(run_id, store=store, deps=deps) == "failed"
    failed = await store.get_run(run_id)
    assert failed is not None and failed.status == RunStatus.FAILED
    old_lease = failed.lease
    assert old_lease is not None
    saved_before = sum(1 for s in await store.get_steps(run_id) if str(s.status) == "completed")
    assert saved_before >= 1

    if stage == "extraction":
        world.fail_extract = set()
        repeated_before = world.extract_calls[C1]
    else:
        world.judge_errors.clear()
        repeated_before = world.stage_calls("collisions")

    retry = await request_run(_request(recipe, f"retry-{stage}", mode="retry"), store=store, deps=deps)
    assert retry.outcome == "requeued" and retry.run.id == run_id
    assert await run_worker(run_id, store=store, deps=deps) == "ready"

    resumed = await store.get_run(run_id)
    assert resumed is not None and resumed.metrics["stepsResumed"] >= saved_before
    assert resumed.attempt == 2 and resumed.lease != old_lease
    if stage == "extraction":
        # The conversation read before the crash was not read again, and no
        # statement was embedded twice across the two attempts.
        assert world.extract_calls[C1] == repeated_before
        assert len(world.embed_calls) == len(set(world.embed_calls))
    else:
        assert world.stage_calls("collisions") == repeated_before

    # The worker that crashed holds a lease that is no longer the run's.
    stale = await store.publish_run(run_id, old_lease, manifest={}, checks=[], metrics={})
    assert stale.outcome == "inactive"


# ── row 4: crash during publication ─────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("point", ["publish:locked", "publish:validated", "publish:heads", "publish:outbox"])
async def test_row_a_crash_during_publication_commits_nothing_and_keeps_the_ready_output(point: str) -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    runs = await _chain(store, world, rec)
    heads = {o.id: o.current_revision_id for o in store.objects.values()}
    events = dict(store.outbox)
    scopes = {s.id: s.current_run_id for s in store.scopes.values()}
    before = await build_manifest(_snapshot_request(), store=store)

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

    def crash(at: str) -> None:
        if at == point:
            raise RuntimeError(f"crashed at {at}")

    store.fault = crash
    broken = await request_run(_request("arguments", "a2"), store=store, deps=world.deps(rec))
    assert await run_worker(broken.run.id, store=store, deps=world.deps(rec)) == "failed"

    # All of it or none of it: heads, scope pointers and the outbox are as they were.
    assert {o.id: o.current_revision_id for o in store.objects.values()} == heads
    assert {s.id: s.current_run_id for s in store.scopes.values()} == scopes
    assert store.outbox.keys() == events.keys()
    # The changed conversation staged new revisions; none of them was published.
    staged = [v.status for v in store.revisions.values() if v.run_id == broken.run.id]
    assert staged and set(staged) == {RevisionStatus.STAGED}
    assert (await _current(store, "arguments")).id == runs["arguments"].id

    # The previous ready output is still usable.
    store.fault = lambda _point: None
    after = await build_manifest(_snapshot_request(), store=store)
    assert after["objects"] == before["objects"] and after["relations"] == before["relations"]


# ── row 5: crash after commit, before notification ──────────────────────


@pytest.mark.asyncio
async def test_row_a_failed_notification_is_retried_and_a_duplicate_dispatch_reruns_nothing() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    deps = world.deps(rec)
    world.verifier = merge_all(MERGED_RECORD)
    outcome = await request_run(_request("arguments", "a1"), store=store, deps=deps)
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "ready"
    (event,) = [e for e in store.outbox.values() if e.run_id == outcome.run.id]
    published = await store.get_run(outcome.run.id)
    assert published is not None

    # The publication committed; telling anyone about it failed.
    rec.publish_error = RuntimeError("redis is down")
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event.id)).retried == 1
    assert store.outbox[event.id].status == "pending" and store.outbox[event.id].attempts == 1
    assert (await _current(store, "arguments")).id == outcome.run.id

    rec.publish_error = None
    store.clock.advance(120)
    calls, runs_before = world.model_calls(), len(store.runs)
    sequence = (await store.get_scope(outcome.run.scope_id)).publication_sequence  # type: ignore[union-attr]

    reports = await asyncio.gather(
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event.id),
        dispatch_events(store=store, deps=rec.outbox_deps(), event_id=event.id),
    )
    assert sum(r.claimed for r in reports) == 1 and sum(r.delivered for r in reports) == 1
    assert store.outbox[event.id].status == "delivered"

    # A duplicate dispatch reran no work and published nothing a second time.
    assert world.model_calls() == calls and len(store.runs) == runs_before
    assert (await store.get_scope(outcome.run.scope_id)).publication_sequence == sequence  # type: ignore[union-attr]
    assert (await store.get_run(outcome.run.id)).output_manifest == published.output_manifest  # type: ignore[union-attr]
    assert len([e for e in store.outbox.values() if e.run_id == outcome.run.id]) == 1


# ── row 6: a dependency changes while tensions are complete ─────────────


@pytest.mark.asyncio
async def test_row_a_changed_dependency_leaves_tensions_pinned_and_stale_without_retargeting() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    runs = await _chain(store, world, rec)
    tension_manifest = dict(runs["tensions"].output_manifest or {})
    supports = [r for r in tension_manifest["relations"] if r["type"].startswith("supports_pole")]
    assert supports
    pinned_ends = {r["from"] for r in supports}
    judge_calls = len(world.judge_calls)

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
    deps = world.deps(rec)
    for recipe, key in (("arguments", "a2"), ("deduplicated_arguments", "d2")):
        refreshed = await request_run(_request(recipe, key), store=store, deps=deps)
        assert await run_worker(refreshed.run.id, store=store, deps=deps) == "ready"
        await dispatch_events(store=store, deps=rec.outbox_deps())

    # The completed tensions kept their pinned inputs and were not rewritten.
    assert (await _current(store, "tensions")).output_manifest == tension_manifest
    assert len(world.judge_calls) == judge_calls

    manifest = await build_manifest(_snapshot_request(), store=store)
    stale = manifest["stale"]
    assert ("output", "tensions") in {(s["kind"], s.get("recipeId")) for s in stale}

    # Historical links never retarget: every support edge still names the exact
    # revision it was established against, whatever that object's head says now.
    for end in pinned_ends:
        relation_id = next(r["relationId"] for r in supports if r["from"] == end)
        assert store.relations[relation_id].from_revision_id == end

    # The refresh did move one of those supporters on (the other consolidated
    # the same members from an unchanged conversation, so it kept its head), so
    # the edges above point into history rather than at what is current.
    moved = [
        end for end in pinned_ends if store.objects[store.revisions[end].object_id].current_revision_id != end
    ]
    assert moved
    for end in moved:
        head = store.objects[store.revisions[end].object_id].current_revision_id
        assert head != end and store.revisions[str(head)].object_id == store.revisions[end].object_id


# ── row 7: two publications, or an edit race, for one scope ─────────────


@pytest.mark.asyncio
async def test_row_lease_order_and_expected_head_decide_competing_writes() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    await _chain(store, world, rec)
    deps = world.deps(rec)

    # Two publications in one scope: request order decides, not completion order.
    older = await request_run(_request("arguments", "old", mode="regenerate"), store=store, deps=deps)
    newer = await request_run(_request("arguments", "new", mode="regenerate"), store=store, deps=deps)
    assert newer.run.request_order > older.run.request_order
    assert await run_worker(newer.run.id, store=store, deps=deps) == "ready"
    assert await run_worker(older.run.id, store=store, deps=deps) == "superseded"
    assert (await _current(store, "arguments")).id == newer.run.id

    # An edit race for one object: the expected head lets exactly one win.
    head = _published(store, "argument")[0]
    edits = RevisionService(store)
    winner = await edits.author_edit(
        project_id=PROJECT,
        object_id=head.object_id,
        expected_revision_id=head.id,
        payload={**head.payload, "statement": "Edited first."},
        actor_id="u1",
    )
    with pytest.raises(RevisionConflict) as conflict:
        await edits.author_edit(
            project_id=PROJECT,
            object_id=head.object_id,
            expected_revision_id=head.id,
            payload={**head.payload, "statement": "Edited second."},
            actor_id="u2",
        )
    assert conflict.value.current is not None and conflict.value.current.id == winner.id
    assert store.objects[head.object_id].current_revision_id == winner.id

    # A generated run that would replace the authored head waits for review and
    # leaves the ready output current.
    current = await _current(store, "arguments")
    regenerated = await request_run(_request("arguments", "g9", mode="regenerate"), store=store, deps=deps)
    assert await run_worker(regenerated.run.id, store=store, deps=deps) == "needs_review"
    assert store.objects[head.object_id].current_revision_id == winner.id
    assert (await _current(store, "arguments")).id == current.id
    assert [
        v.status for v in store.revisions.values() if v.run_id == regenerated.run.id and v.object_id == head.object_id
    ] == [RevisionStatus.CANDIDATE]


# ── row 8: re-check a claim after a snapshot was shared ─────────────────


class _Checker:
    def __init__(self, verdict: str) -> None:
        self.verdict = verdict
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {
            "verdict": self.verdict,
            "justification": f"The fixture says {self.verdict}.",
            "sources": [{"url": "https://example.org", "title": "Example"}],
        }


async def _project_context(project_id: str) -> tuple[str, str]:  # noqa: ARG001
    return "Harbour", "Trams or buses."


async def _check(maps: MapWorld, snapshot: Any, revision_id: str, checker: _Checker, *, force: bool = False) -> str:
    jobs: list[tuple[Any, ...]] = []
    state = await service.start_snapshot_fact_check(
        service.SnapshotTarget(snapshot),
        revision_id,
        requested_by="du1",
        force=force,
        store=maps.map_store,
        analysis_store=maps.store,
        dispatch=lambda *job: jobs.append(job) or "msg",
    )
    assert state["status"] == "processing"
    (job,) = jobs
    return await run_fact_check(
        *job,
        store=maps.map_store,
        check=checker,
        project_context=_project_context,
        publish=maps.publish,
        redis=FakeAsyncRedis(),
        analysis_store=maps.store,
        reads=maps.reads,
        executor_deps=Recorder().deps(),
    )


@pytest.mark.asyncio
async def test_row_a_recheck_advances_the_view_and_the_shared_snapshot_keeps_its_assessment() -> None:
    world, rec = ProducerWorld.recording_debate(), Recorder()
    maps = MapWorld()
    deps = world.deps(rec)
    outcome = await request_run(_request("arguments", "a1"), store=maps.store, deps=deps)
    assert await run_worker(outcome.run.id, store=maps.store, deps=deps) == "ready"
    first = await maps.advance(PROJECT)

    claim = next(
        r for r in _published(maps.store, "argument") if r.payload.get("statement") == BRIDGE
    )
    assert claim.attributes.get("epistemicKind") == "claim"

    assert await _check(maps, first, claim.id, _Checker("false")) == "done"
    shared = maps.current(PROJECT)
    assert shared.id != first.id

    assert await _check(maps, shared, claim.id, _Checker("true"), force=True) == "done"
    latest = maps.current(PROJECT)

    # The following view advanced; the shared snapshot still resolves the
    # assessment it was shared with.
    assert latest.parent_snapshot_id == shared.id
    assert (await read_snapshot(shared, store=maps.store)).assessments[claim.id].payload["verdict"] == "false"
    assert (await read_snapshot(latest, store=maps.store)).assessments[claim.id].payload["verdict"] == "true"
    target = service.SnapshotTarget
    shared_states = await service.snapshot_fact_check_states(
        target(shared), store=maps.map_store, analysis_store=maps.store
    )
    latest_states = await service.snapshot_fact_check_states(
        target(latest), store=maps.map_store, analysis_store=maps.store
    )
    assert shared_states[claim.id]["verdict"] == "false"
    assert latest_states[claim.id]["verdict"] == "true"
    # Both assessments are kept: a re-check appends, it never erases.
    assessments = [r for r in maps.store.revisions.values() if r.type == "fact_check_assessment"]
    assert len(assessments) == 2 and len({r.object_id for r in assessments}) == 1


# ── row 9: a similarity chain A to B to C ───────────────────────────────

CHAIN_A = "Speed bumps should be added on Main Street."
CHAIN_B = "Traffic calming measures should be added on Main Street."
CHAIN_C = "Traffic calming measures should be added across the whole district."


def _chain_world() -> ProducerWorld:
    """One conversation whose three arguments form a similarity chain: A to B
    and B to C are close, A to C is not."""
    world = ProducerWorld()
    text = "\n".join(f"Ann: {statement}" for statement in (CHAIN_A, CHAIN_B, CHAIN_C))
    world.add(
        C1,
        "Ann",
        text,
        [item(CHAIN_A, CHAIN_A), item(CHAIN_B, CHAIN_B), item(CHAIN_C, CHAIN_C)],
        1,
    )
    world.vectors[CHAIN_A] = planar(0, world.dims)
    world.vectors[CHAIN_B] = planar(30, world.dims)
    world.vectors[CHAIN_C] = planar(60, world.dims)
    return world


@pytest.mark.asyncio
async def test_row_a_similarity_chain_fails_verification_and_keeps_its_distinctions() -> None:
    world, store, rec = _chain_world(), FakeAnalysisStore(), Recorder()
    deps = world.deps(rec)
    arguments = await request_run(_request("arguments", "a1"), store=store, deps=deps)
    assert await run_worker(arguments.run.id, store=store, deps=deps) == "ready"
    await dispatch_events(store=store, deps=rec.outbox_deps())
    by_statement = {r.payload["statement"]: r for r in _published(store, "argument")}
    assert set(by_statement) == {CHAIN_A, CHAIN_B, CHAIN_C}

    # A threshold low enough to propose all three as one candidate group, and a
    # verifier that judges one end apart from the proposed statement.
    world.verifier = merge_all("Traffic should be calmed.", refuse={CHAIN_C})
    dedup = await request_run(
        _request("deduplicated_arguments", "d1", parameters={"similarity_threshold": 0.4}),
        store=store,
        deps=deps,
    )
    assert await run_worker(dedup.run.id, store=store, deps=deps) == "ready"

    run = await store.get_run(dedup.run.id)
    assert run is not None and run.output_manifest is not None
    outputs = _published(store, "deduplicated_argument")
    members_of = {
        o.id: {
            store.relations[r["relationId"]].to_revision_id
            for r in run.output_manifest["relations"]
            if r["type"] == "derived_from" and r["from"] == o.id
        }
        for o in outputs
    }

    ends = {by_statement[CHAIN_A].id, by_statement[CHAIN_C].id}
    # The combined merge failed verification: nothing holds both ends.
    assert not any(ends <= members for members in members_of.values())
    # Every input is accounted for exactly once, so no distinction was dropped.
    accounted = [rid for members in members_of.values() for rid in members]
    assert sorted(accounted) == sorted(r.id for r in by_statement.values())
    assert len(accounted) == len(set(accounted))
    # The original arguments and their evidence are untouched and inspectable.
    assert {r.payload["statement"] for r in _published(store, "argument")} == {CHAIN_A, CHAIN_B, CHAIN_C}
    assert all(r.payload["evidence"] for r in by_statement.values())


# ── row 10: hiding a type or raising the rendering budget ───────────────


@pytest.mark.asyncio
async def test_row_filters_and_budgets_start_no_extraction_deduplication_or_delivery() -> None:
    world, rec = ProducerWorld.recording_debate(), Recorder()
    maps = MapWorld()
    register_recipe(delivery.RECIPE, replace=True)
    try:
        await _chain(maps.store, world, rec)
        snapshot = await maps.advance(PROJECT)
        before = (
            len(maps.store.runs),
            world.model_calls(),
            len(maps.store.outbox),
            len(maps.store.revisions),
            sum(world.extract_calls.values()),
            len(world.verify_calls),
        )

        queries = [
            GraphQuery(types=(), scope=None, budgets=resolve_budgets(ceilings=Ceilings())),
            GraphQuery(types=("tension",), scope=None, budgets=resolve_budgets(ceilings=Ceilings())),
            # Named explicitly: left to itself the server picks a default
            # selection that fits, which would never be over budget.
            GraphQuery(
                types=("deduplicated_argument",),
                scope=None,
                budgets=resolve_budgets(2, None, ceilings=Ceilings()),
            ),
            GraphQuery(types=None, scope=None, budgets=resolve_budgets(500, 900, ceilings=Ceilings())),
        ]
        payloads = [await graph_payload(snapshot, query, store=maps.store) for query in queries]

        assert payloads[0]["nodes"] == [] and payloads[0]["overBudget"] is False
        assert {n["type"] for n in payloads[1]["nodes"]} == {"tension"}
        assert payloads[2]["overBudget"] is True and payloads[2]["nodes"] == []
        # Raising the budget admits the objects again without regenerating them.
        assert payloads[3]["overBudget"] is False and payloads[3]["nodes"]

        after = (
            len(maps.store.runs),
            world.model_calls(),
            len(maps.store.outbox),
            len(maps.store.revisions),
            sum(world.extract_calls.values()),
            len(world.verify_calls),
        )
        assert after == before
        # No delivery was started either: a rendering choice is not a run.
        assert [r for r in maps.store.runs.values() if r.recipe_id == delivery.RECIPE_ID] == []
        assert maps.store.snapshots[snapshot.id].manifest == snapshot.manifest
    finally:
        unregister_recipe(delivery.RECIPE_ID)


# ── row 11: a source becomes unavailable ────────────────────────────────


@pytest.mark.asyncio
async def test_row_an_unavailable_source_is_marked_missing_and_never_substituted() -> None:
    world, rec = ProducerWorld.recording_debate(), Recorder()
    maps = MapWorld()
    await _chain(maps.store, world, rec)
    snapshot = await maps.advance(PROJECT)
    tension = next(o for o in snapshot.manifest["objects"] if o["type"] == "tension")

    lineage = await pinned_lineage(snapshot, tension["revisionId"], store=maps.store)
    assert lineage is not None and lineage["missing"] == []
    evidence_before = {
        r["revisionId"]: r["payload"].get("evidence") for r in lineage["revisions"] if "evidence" in r["payload"]
    }
    assert evidence_before

    # The conversation is gone from the project. Historical inspection keeps the
    # source references that were checked when the revisions were written, and
    # never resolves them against whatever the project holds today.
    world.transcripts = [t for t in world.transcripts if t.id != C3]
    unchanged = await pinned_lineage(snapshot, tension["revisionId"], store=maps.store)
    assert unchanged is not None and unchanged["missing"] == []
    assert {
        r["revisionId"]: r["payload"].get("evidence") for r in unchanged["revisions"] if "evidence" in r["payload"]
    } == evidence_before

    # A pinned revision the project may no longer serve is reported missing,
    # and nothing takes its place.
    deepest = next(
        rid
        for rid in (e["to"] for e in lineage["edges"])
        if maps.store.revisions[rid].type == "argument"
    )
    del maps.store.revisions[deepest]

    after = await pinned_lineage(snapshot, tension["revisionId"], store=maps.store)
    assert after is not None
    assert deepest in after["missing"]
    assert deepest not in {r["revisionId"] for r in after["revisions"]}
    # The edge still names the revision that was pinned, not a newer stand-in.
    assert deepest in {e["to"] for e in after["edges"]}
    assert len(after["revisions"]) == len(lineage["revisions"]) - 1

    contents = await read_snapshot(snapshot, store=maps.store)
    assert all(
        rid not in contents.revisions for rid in [deepest] if rid in {o["revisionId"] for o in snapshot.manifest["objects"]}
    )
    assert types.get_object_type("tension").map is not None
