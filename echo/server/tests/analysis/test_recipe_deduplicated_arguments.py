"""The deduplicated arguments recipe through the executor, on the in-memory
store with scripted transcripts, embeddings and verifier."""

from __future__ import annotations

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, request_run, execute_inline
from dembrane.analysis.registry import InvalidRecipeRequest
from dembrane.analysis.contracts import Run, Relation, RunStatus, StepStatus, ObjectRevision
from tests.analysis.producer_fakes import (
    C1,
    C2,
    C3,
    TRAMS,
    RECORD,
    PARKING,
    PROJECT,
    RECORDINGS,
    MERGED_RECORD,
    ProducerWorld,
    item,
    planar,
    merge_all,
)
from dembrane.analysis.recipes.deduplication import lineage_key

TRAM_HOURLY = "Night trams should run every hour."
TRAM_HOURLY_2 = "Trams should run every hour at night."
TRAM_WINTER = "Trams should run every hour at night, except in winter."


def _request(**kwargs: object) -> RunRequest:
    return RunRequest(project_id=PROJECT, recipe_id="deduplicated_arguments", scope_key="project", **kwargs)  # type: ignore[arg-type]


async def _inline(store: FakeAnalysisStore, world: ProducerWorld, key: str, **kwargs: object) -> Run:
    outcome = await execute_inline(_request(idempotency_key=key, **kwargs), store=store, deps=world.deps(Recorder()))
    return outcome.run


def _objects(store: FakeAnalysisStore, run: Run) -> list[ObjectRevision]:
    assert run.output_manifest is not None
    return [store.revisions[o["revisionId"]] for o in run.output_manifest["objects"]]


def _relations(store: FakeAnalysisStore, run: Run) -> list[Relation]:
    assert run.output_manifest is not None
    return [store.relations[r["relationId"]] for r in run.output_manifest["relations"]]


def _arguments_run(store: FakeAnalysisStore, run: Run) -> Run:
    assert run.input_manifest is not None
    return store.runs[run.input_manifest["dependencies"]["arguments"]["runId"]]


def _chain_world(degrees: tuple[float, float, float]) -> ProducerWorld:
    world = ProducerWorld()
    for index, (cid, statement, angle) in enumerate(
        zip((C1, C2, C3), (TRAM_HOURLY, TRAM_HOURLY_2, TRAM_WINTER), degrees, strict=True), start=1
    ):
        world.add(cid, f"Speaker {index}", f"Speaker: {statement}", [item(statement, statement.rstrip("."))], index)
        world.vectors[statement] = planar(angle, world.dims)
    return world


@pytest.mark.asyncio
async def test_equivalent_arguments_consolidate_with_derived_from_relations_to_every_member() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.verifier = merge_all(MERGED_RECORD)
    run = await _inline(store, world, "d1")
    assert run.status == RunStatus.READY
    arguments = _arguments_run(store, run)
    argument_ids = {o["revisionId"] for o in arguments.output_manifest["objects"]}  # type: ignore[index]
    embeds_after_arguments = 7

    outputs = {r.payload["statement"]: r for r in _objects(store, run)}
    assert len(outputs) == 6 and {r.type for r in outputs.values()} == {"deduplicated_argument"}
    # Only the near-duplicate pair reaches the verifier; identical statements merge without a call.
    (request,) = world.verify_calls
    assert {m.statement for m in request.members} == {RECORD, RECORDINGS}

    merged = outputs[MERGED_RECORD]
    consolidation = merged.payload["consolidation"]
    assert consolidation["verification"] == "verified" and consolidation["memberCount"] == 2
    assert consolidation["rationale"] == "The same position in other words."
    assert consolidation["coverage"]["outcome"] == "merged" and consolidation["coverage"]["method"] == "model"
    assert {e["conversationId"] for e in merged.payload["evidence"]} == {C1, C3}
    assert len(merged.provenance.source_refs) == 2 and merged.attributes["epistemicKind"] == "argument"

    trams = outputs[TRAMS].payload
    assert trams["consolidation"]["verification"] == "verified" and trams["consolidation"]["coverage"]["outcome"] == "exact_match"
    parking = outputs[PARKING].payload["consolidation"]
    assert (parking["verification"], parking["memberCount"], parking["coverage"]["outcome"]) == ("singleton", 1, "no_candidate")

    relations = _relations(store, run)
    assert {r.type for r in relations} == {"derived_from"}
    # Every input revision is the source of exactly one output.
    assert sorted(r.to_revision_id for r in relations) == sorted(argument_ids)
    by_output: dict[str, list[Relation]] = {}
    for relation in relations:
        by_output.setdefault(relation.from_revision_id, []).append(relation)
    assert [r.basis for r in by_output[merged.id]] == ["inferred", "inferred"]
    assert {r.attributes["rationale"] for r in by_output[merged.id]} <= {"checked m1", "checked m2"}
    assert [str(r.basis) for r in by_output[outputs[TRAMS].id]] == ["extracted", "extracted"]
    member_objects = [store.revisions[r.to_revision_id].object_id for r in by_output[merged.id]]
    assert store.objects[merged.object_id].lineage_key == f"deduplicated_arguments/project/{lineage_key(member_objects)}"
    assert set(merged.provenance.input_revision_ids) == {r.to_revision_id for r in by_output[merged.id]}

    # Only the new statement is embedded; every other output reuses its member's vector.
    assert world.embed_calls[embeds_after_arguments:] == [MERGED_RECORD]
    assert (merged.embedding_refs or {})["embeddingId"] in store.embeddings
    checks = {c["check"]: c for c in run.checks}
    assert checks["accounts-for-every-input"]["evidence"]["inputs"] == 8
    assert checks["accounts-for-every-input"]["evidence"]["outputs"] == 6
    assert checks["candidate-coverage"]["evidence"]["threshold"] == 0.8
    assert checks["candidate-coverage"]["evidence"]["unverifiedGroups"] == []
    assert run.metrics["modelCalls"] == 1 and run.metrics["tokens.total_tokens"] == 120
    steps = {s.step_key.split(":")[0] for s in await store.get_steps(run.id)}
    assert steps == {"discover", "verify", "assemble", "embed"}


@pytest.mark.asyncio
async def test_a_similarity_chain_does_not_merge_its_distinct_ends() -> None:
    # All three within the threshold of each other: one candidate group, but the
    # verifier's check refuses the qualified member, so nothing merges.
    world, store = _chain_world((0, 20, 35)), FakeAnalysisStore()
    world.verifier = merge_all("Trams should run hourly at night.", refuse={TRAM_WINTER})
    run = await _inline(store, world, "d1")
    assert run.status == RunStatus.READY and len(world.verify_calls) == 1
    outputs = _objects(store, run)
    assert len(outputs) == 3
    assert {r.payload["consolidation"]["coverage"]["outcome"] for r in outputs} == {"member_not_equivalent"}
    assert {r.payload["consolidation"]["verification"] for r in outputs} == {"singleton"}

    # A at 0, B at 30, C at 60 degrees: A and C are not candidates together, so
    # even a verifier that merges everything it is shown cannot join them.
    world, store = _chain_world((0, 30, 60)), FakeAnalysisStore()
    world.verifier = merge_all("Trams should run hourly at night.")
    run = await _inline(store, world, "d1")
    (request,) = world.verify_calls
    assert {m.statement for m in request.members} == {TRAM_HOURLY, TRAM_HOURLY_2}
    by_statement = {r.payload["statement"]: r for r in _objects(store, run)}
    assert set(by_statement) == {"Trams should run hourly at night.", TRAM_WINTER}
    assert by_statement[TRAM_WINTER].payload["consolidation"]["memberCount"] == 1


@pytest.mark.asyncio
async def test_a_failed_verification_publishes_with_the_group_apart_and_listed() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.verify_error = RuntimeError("the provider is down")
    run = await _inline(store, world, "d1")
    assert run.status == RunStatus.READY
    outputs = {r.payload["statement"]: r for r in _objects(store, run)}
    assert len(outputs) == 7 and RECORD in outputs and RECORDINGS in outputs
    status = outputs[RECORD].payload["consolidation"]
    assert (status["verification"], status["coverage"]["outcome"]) == ("uncertain", "call_failed")
    coverage = next(c for c in run.checks if c["check"] == "candidate-coverage")
    assert coverage["status"] == "passed" and coverage["evidence"]["unverifiedGroups"] == [status["coverage"]["groupId"]]
    (verify,) = [s for s in await store.get_steps(run.id) if s.step_key.startswith("verify:")]
    assert verify.status == StepStatus.COMPLETED and verify.output == {"status": "call_failed", "error": "RuntimeError"}


@pytest.mark.asyncio
async def test_refresh_reuses_and_regenerate_verifies_again_with_the_same_vectors() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.verifier = merge_all(MERGED_RECORD)
    first = await _inline(store, world, "d1")
    embeds, probes = len(world.embed_calls), world.probe_calls

    reuse = await request_run(_request(idempotency_key="d2"), store=store, deps=world.deps(Recorder()))
    assert reuse.outcome == "reused" and reuse.run.reused_run_id == first.id and len(world.verify_calls) == 1

    again = await _inline(store, world, "g1", mode="regenerate")
    assert again.status == RunStatus.READY and again.epoch == first.epoch + 1
    assert len(world.verify_calls) == 2 and again.metrics["modelCalls"] == 1
    assert (len(world.embed_calls), world.probe_calls) == (embeds, probes)
    assert again.metrics["objectsReused"] == 6
    assert sum(world.extract_calls.values()) == 3  # the pinned arguments were not regenerated


@pytest.mark.asyncio
async def test_invalid_parameters_fail_before_anything_is_written() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    with pytest.raises(InvalidRecipeRequest):
        await request_run(_request(parameters={"max_group_size": 1}), store=store, deps=world.deps(Recorder()))
    assert store.runs == {} and world.model_calls() == 0
