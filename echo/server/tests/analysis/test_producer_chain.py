"""Arguments, deduplicated arguments and tensions as one dependency chain:
requested once, woken by publication, pinned to exact manifests, failing and
going stale one producer at a time."""

from __future__ import annotations

from typing import Any

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.outbox import dispatch_events
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.contracts import Run, RunStatus
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

CHAIN = ("arguments", "deduplicated_arguments", "tensions")


def _request(recipe: str, key: str, **kwargs: Any) -> RunRequest:
    parameters = {"input_set": "deduplicated_arguments"} if recipe == "tensions" else {}
    return RunRequest(
        project_id=PROJECT, recipe_id=recipe, scope_key="project", parameters=parameters, idempotency_key=key, **kwargs
    )


async def _current(store: FakeAnalysisStore, recipe: str) -> Run:
    scope = await store.find_scope(project_id=PROJECT, kind="producer", owner_id=recipe, scope_key="project")  # type: ignore[arg-type]
    assert scope is not None and scope.current_run_id is not None
    run = await store.get_run(scope.current_run_id)
    assert run is not None
    return run


async def _chain(store: FakeAnalysisStore, world: ProducerWorld, rec: Recorder) -> dict[str, Run]:
    """Request tensions once, then work the queue the way the workers and the
    outbox dispatcher would."""
    deps = world.deps(rec)
    outcome = await request_run(_request("tensions", "chain"), store=store, deps=deps)
    arguments, dedup = outcome.dependencies
    assert (arguments.status, dedup.status, outcome.run.status) == (
        RunStatus.QUEUED,
        RunStatus.WAITING_FOR_INPUTS,
        RunStatus.WAITING_FOR_INPUTS,
    )
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


@pytest.mark.asyncio
async def test_the_chain_wakes_in_order_and_pins_each_exact_manifest() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    world.verifier = merge_all(MERGED_RECORD)
    runs = await _chain(store, world, rec)

    for consumer, dependency in (("deduplicated_arguments", "arguments"), ("tensions", "deduplicated_arguments")):
        pinned = runs[consumer].input_manifest["dependencies"]["arguments"]  # type: ignore[index]
        upstream = runs[dependency]
        assert pinned["runId"] == upstream.id and pinned["manifestHash"] == upstream.output_manifest["contentHash"]  # type: ignore[index]
        assert runs[consumer].depends_on == [upstream.id]

    argument_ids = {o["revisionId"] for o in runs["arguments"].output_manifest["objects"]}  # type: ignore[index]
    dedup_ids = {o["revisionId"] for o in runs["deduplicated_arguments"].output_manifest["objects"]}  # type: ignore[index]
    lineage = runs["deduplicated_arguments"].output_manifest["relations"]  # type: ignore[index]
    supports = runs["tensions"].output_manifest["relations"]  # type: ignore[index]
    assert {r["to"] for r in lineage} == argument_ids
    assert {r["type"] for r in supports} == {"supports_pole_a", "supports_pole_b"}
    assert all(r["from"] in dedup_ids for r in supports)

    snapshot = await build_manifest(_snapshot_request(), store=store)
    assert snapshot["stale"] == [] and all(p["available"] for p in snapshot["producers"])
    assert len([o for o in snapshot["objects"] if o["type"] == "tension"]) == 1


@pytest.mark.asyncio
async def test_a_failure_in_tensions_leaves_arguments_and_deduplicated_arguments_ready() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    world.verifier = merge_all(MERGED_RECORD)
    world.judge_errors["verify"] = ValueError("the fake judge answered badly")
    deps = world.deps(rec)
    outcome = await request_run(_request("tensions", "chain"), store=store, deps=deps)
    arguments, dedup = outcome.dependencies
    assert await run_worker(arguments.id, store=store, deps=deps) == "ready"
    await dispatch_events(store=store, deps=rec.outbox_deps())
    assert await run_worker(dedup.id, store=store, deps=deps) == "ready"
    await dispatch_events(store=store, deps=rec.outbox_deps())
    assert await run_worker(outcome.run.id, store=store, deps=deps) == "failed"

    failed = await store.get_run(outcome.run.id)
    assert failed is not None and failed.status == RunStatus.FAILED
    assert (await _current(store, "arguments")).id == arguments.id
    assert (await _current(store, "deduplicated_arguments")).id == dedup.id
    scope = await store.get_scope(failed.scope_id)
    assert scope is not None and scope.current_run_id is None
    assert not [v for v in store.revisions.values() if v.type == "tension" and str(v.status) == "published"]

    # A retry resumes the saved judgements and asks only what failed.
    world.judge_errors.clear()
    collisions = world.stage_calls("collisions")
    retry = await request_run(_request("tensions", "retry", mode="retry"), store=store, deps=deps)
    assert retry.run.id == failed.id
    assert await run_worker(failed.id, store=store, deps=deps) == "ready"
    assert world.stage_calls("collisions") == collisions


@pytest.mark.asyncio
async def test_a_changed_conversation_makes_downstream_outputs_stale_without_rewriting_them() -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    world.verifier = merge_all(MERGED_RECORD)
    runs = await _chain(store, world, rec)
    dedup_manifest = dict(runs["deduplicated_arguments"].output_manifest or {})
    tension_manifest = dict(runs["tensions"].output_manifest or {})
    verify_calls, judge_calls = len(world.verify_calls), len(world.judge_calls)

    world.set_text(
        C3,
        "Cas: Buses are cheaper to run than trams at night.\n"
        "Cas: Keep the recordings, the notes never capture what people meant.\n"
        "Cas: Honestly, just keep the recordings.",
        [
            item("Night buses are cheaper to run than night trams.", "Buses are cheaper to run than trams at night"),
            item(RECORDINGS, "Keep the recordings, the notes never capture what people meant", "just keep the recordings"),
        ],
    )
    deps = world.deps(rec)
    refreshed = await request_run(_request("arguments", "a2"), store=store, deps=deps)
    assert await run_worker(refreshed.run.id, store=store, deps=deps) == "ready"
    assert world.extract_calls[C3] == 2 and sum(world.extract_calls.values()) == 4

    # Nothing downstream ran: the deduplication and the tensions keep their pinned inputs.
    assert (await _current(store, "deduplicated_arguments")).output_manifest == dedup_manifest
    assert (await _current(store, "tensions")).output_manifest == tension_manifest
    assert (len(world.verify_calls), len(world.judge_calls)) == (verify_calls, judge_calls)
    stale = (await build_manifest(_snapshot_request(), store=store))["stale"]
    assert {(s["kind"], s.get("recipeId")) for s in stale} == {("output", "deduplicated_arguments"), ("relation", None)}
    # Both arguments of the changed conversation have new revisions (their
    # evidence names the new transcript), so both lineage edges are stale.
    lineage_edges = [s for s in stale if s["kind"] == "relation"]
    assert {store.relations[s["relationId"]].type for s in lineage_edges} == {"derived_from"}
    assert {store.revisions[s["pinnedRevisionId"]].payload["evidence"][0]["conversationId"] for s in lineage_edges} == {C3}
    assert RECORDINGS in {store.revisions[s["pinnedRevisionId"]].payload["statement"] for s in lineage_edges}

    # Refreshing the deduplication verifies the changed group again, keeps the
    # consolidated identity with a new revision, and now the tension is stale:
    # its support edge stays on the older revision rather than being redrawn.
    dedup = await request_run(_request("deduplicated_arguments", "d2"), store=store, deps=deps)
    assert dedup.outcome == "created"
    assert await run_worker(dedup.run.id, store=store, deps=deps) == "ready"
    assert len(world.verify_calls) == verify_calls + 1
    stale = (await build_manifest(_snapshot_request(), store=store))["stale"]
    assert {(s["kind"], s.get("recipeId")) for s in stale} == {("output", "tensions"), ("relation", None)}
    (edge,) = [s for s in stale if s["kind"] == "relation"]
    old, new = store.revisions[edge["pinnedRevisionId"]], store.revisions[edge["displayedRevisionId"]]
    assert old.object_id == new.object_id and old.payload["statement"] == new.payload["statement"] == MERGED_RECORD
    assert (await _current(store, "tensions")).output_manifest == tension_manifest
    assert any(r["from"] == old.id for r in tension_manifest["relations"])
