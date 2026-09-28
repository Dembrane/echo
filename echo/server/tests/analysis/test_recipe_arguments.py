"""The arguments recipe through the executor, on the in-memory store with
scripted transcripts, extractor and embeddings."""

from __future__ import annotations

import pytest

from dembrane.map import recipe as map_recipe
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.contracts import Run, RunStatus, StepStatus, ObjectRevision
from tests.analysis.producer_fakes import (
    C1,
    C2,
    C3,
    BUSES,
    TRAMS,
    BRIDGE,
    PARKING,
    PROJECT,
    RECORDINGS,
    ProducerWorld,
    item,
)


def _request(**kwargs: object) -> RunRequest:
    return RunRequest(project_id=PROJECT, recipe_id="arguments", scope_key="project", **kwargs)  # type: ignore[arg-type]


async def _run(store: FakeAnalysisStore, world: ProducerWorld, key: str, **kwargs: object) -> tuple[Run, str]:
    rec = Recorder()
    outcome = await request_run(_request(idempotency_key=key, **kwargs), store=store, deps=world.deps(rec))
    status = await run_worker(outcome.run.id, store=store, deps=world.deps(rec))
    run = await store.get_run(outcome.run.id)
    assert run is not None
    return run, status


def _objects(store: FakeAnalysisStore, run: Run) -> list[ObjectRevision]:
    assert run.output_manifest is not None
    return [store.revisions[o["revisionId"]] for o in run.output_manifest["objects"]]


def _by_statement(revisions: list[ObjectRevision], conversation: str) -> dict[str, ObjectRevision]:
    return {
        r.payload["statement"]: r for r in revisions if r.payload["evidence"][0]["conversationId"] == conversation
    }


@pytest.mark.asyncio
async def test_arguments_publish_grounded_typed_objects_with_evidence_and_vectors() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    run, status = await _run(store, world, "a1")
    assert status == "ready" and run.status == RunStatus.READY

    revisions = _objects(store, run)
    # The ungrounded "cars" item is dropped; nothing is consolidated across conversations.
    assert len(revisions) == 8 and {r.type for r in revisions} == {"argument"}
    c1, c2 = _by_statement(revisions, C1), _by_statement(revisions, C2)
    assert c1[TRAMS].object_id != c2[TRAMS].object_id
    assert c1[PARKING].attributes == {"valence": "negative", "epistemicKind": "argument"}
    assert c2[BRIDGE].attributes == {"valence": "neutral", "epistemicKind": "claim"}
    assert c2[BRIDGE].provenance.extra["claimKey"] == map_recipe.claim_key(BRIDGE, ["The old bridge was built in 1932"])

    transcript = next(t for t in world.transcripts if t.id == C1)
    trams = c1[TRAMS]
    assert trams.payload["evidence"] == [
        {
            "conversationId": C1,
            "label": "Ann",
            "createdAt": "2026-09-11T10:00:00Z",
            "quotes": ["The city should add night trams on the main line"],
        }
    ]
    (ref,) = trams.provenance.source_refs
    assert (ref.conversation_id, ref.source_fingerprint, ref.quote) == (
        C1,
        transcript.text_hash,
        "The city should add night trams on the main line",
    )
    assert ref.location == {"offset": 5, "basis": "collapsed-casefold-v1"}
    refs = trams.embedding_refs or {}
    assert refs["configKey"] == world.identity().key and refs["projectionVersion"] == "statement-v1"
    assert refs["embeddingId"] in store.embeddings and refs["model"] == "text-embedding-004"
    assert trams.provenance.recipe_id == "arguments" and trams.provenance.recipe_version == "arguments-v1"
    assert trams.object_id in {store.objects[r.object_id].id for r in revisions}
    assert store.objects[trams.object_id].lineage_key.startswith(f"arguments/project/{C1}:c-")

    steps = {s.step_key: s for s in await store.get_steps(run.id)}
    assert sorted(steps) == sorted(["load", f"extract:{C1}", f"extract:{C2}", f"extract:{C3}", "ground", "merge", "embed"])
    assert all(s.status == StepStatus.COMPLETED for s in steps.values())
    assert steps[f"extract:{C1}"].output["windows"][0]["items"][3]["statement"] == "Cars should be banned."
    (grounding,) = steps["ground"].validation
    assert grounding["check"] == "quotes-verbatim" and grounding["evidence"]["dropped"] == 1
    assert {c["check"] for c in run.checks} >= {"schema", "references", "embeddings-durable", "quotes-verbatim"}
    assert run.metrics["modelCalls"] == 3 and run.metrics["tokens.total_tokens"] == 360
    assert run.metrics["droppedUngrounded"] == 1 and run.metrics["embeddingsComputed"] == 7
    assert world.probe_calls == 1 and len(world.embed_calls) == 7
    assert [s["conversationId"] for s in run.input_manifest["sources"]] == [C1, C2, C3]  # type: ignore[index]
    extract = next(s for s in run.definition["steps"] if s["key"] == "extract")
    assert extract["promptVersion"] == "map-arguments-v2"


@pytest.mark.asyncio
async def test_the_same_item_seen_in_overlapping_windows_is_one_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(map_recipe, "transcript_windows", lambda text: [text, text])
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    run, status = await _run(store, world, "a1")
    assert status == "ready"
    revisions = _objects(store, run)
    assert len(revisions) == 8 and all(len(r.payload["evidence"][0]["quotes"]) == 1 for r in revisions)
    assert sum(world.extract_calls.values()) == 6 and run.metrics["modelCalls"] == 6


@pytest.mark.asyncio
async def test_a_refresh_with_unchanged_transcripts_calls_nothing() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    first, _ = await _run(store, world, "a1")
    calls, embeds, probes = world.model_calls(), len(world.embed_calls), world.probe_calls

    rec = Recorder()
    again = await request_run(_request(idempotency_key="a2"), store=store, deps=world.deps(rec))
    assert again.outcome == "reused" and again.run.reused_run_id == first.id
    assert (world.model_calls(), len(world.embed_calls), world.probe_calls) == (calls, embeds, probes)
    assert rec.dispatched == []


@pytest.mark.asyncio
async def test_a_changed_conversation_recomputes_only_its_extraction() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    first, _ = await _run(store, world, "a1")
    reworded = "Night buses cost less to run than night trams."
    world.set_text(
        C3,
        "Cas: Buses are cheaper to run than trams at night.\n"
        "Cas: Keep the recordings, the notes never capture what people meant.\n"
        "Cas: Honestly, just keep the recordings.",
        [
            item(reworded, "Buses are cheaper to run than trams at night"),
            item(RECORDINGS, "Keep the recordings, the notes never capture what people meant", "just keep the recordings"),
        ],
    )
    embeds = len(world.embed_calls)
    second, status = await _run(store, world, "a2")
    assert status == "ready"
    assert world.extract_calls == {C1: 1, C2: 1, C3: 2}
    assert second.metrics["modelCalls"] == 1 and second.metrics["cacheHits"] == 2
    assert world.embed_calls[embeds:] == [reworded]

    before, after = _objects(store, first), _objects(store, second)
    for conversation in (C1, C2):
        assert {r.id for r in _by_statement(before, conversation).values()} == {
            r.id for r in _by_statement(after, conversation).values()
        }
    old_c3, new_c3 = _by_statement(before, C3), _by_statement(after, C3)
    # More quotes for the same statement: a new revision of the same object.
    assert new_c3[RECORDINGS].object_id == old_c3[RECORDINGS].object_id
    assert new_c3[RECORDINGS].parent_revision_id == old_c3[RECORDINGS].id
    # A reworded statement has no known continuity: a new object, the old one leaves the output.
    assert new_c3[reworded].object_id != old_c3[BUSES].object_id and BUSES not in new_c3
    assert store.revisions[old_c3[BUSES].id].payload["statement"] == BUSES


@pytest.mark.asyncio
async def test_regenerate_calls_the_extractor_again_and_reuses_every_vector() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    first, _ = await _run(store, world, "a1")
    embeds, probes = len(world.embed_calls), world.probe_calls
    again, status = await _run(store, world, "g1", mode="regenerate")
    assert status == "ready" and again.epoch == first.epoch + 1
    assert sum(world.extract_calls.values()) == 6 and again.metrics["modelCalls"] == 3
    assert (len(world.embed_calls), world.probe_calls) == (embeds, probes)
    assert again.metrics["objectsReused"] == 8


@pytest.mark.asyncio
async def test_a_transcript_that_changed_after_pinning_fails_the_run_before_any_call() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    rec = Recorder()
    outcome = await request_run(_request(idempotency_key="a1"), store=store, deps=world.deps(rec))
    world.set_text(C2, "Bob: something else entirely.")
    assert await run_worker(outcome.run.id, store=store, deps=world.deps(rec)) == "failed"
    run = await store.get_run(outcome.run.id)
    assert run is not None and "changed after this run pinned" in (run.error or "")
    assert world.model_calls() == 0 and not store.revisions


@pytest.mark.asyncio
async def test_a_failed_conversation_fails_the_run_and_a_retry_reads_only_that_one() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.fail_extract = {C2}
    run, status = await _run(store, world, "a1")
    assert status == "failed" and run.error == "Reading 1 of 3 conversations failed."
    steps = {s.step_key: s.status for s in await store.get_steps(run.id)}
    assert steps[f"extract:{C1}"] == steps[f"extract:{C3}"] == StepStatus.COMPLETED
    assert steps[f"extract:{C2}"] == StepStatus.FAILED

    world.fail_extract = set()
    retried, status = await _run(store, world, "r1", mode="retry")
    assert status == "ready" and retried.id == run.id
    assert world.extract_calls == {C1: 1, C2: 2, C3: 1}


@pytest.mark.asyncio
async def test_a_project_without_transcripts_publishes_an_empty_output() -> None:
    world, store = ProducerWorld(), FakeAnalysisStore()
    run, status = await _run(store, world, "a1")
    assert status == "ready" and run.output_manifest is not None and run.output_manifest["objects"] == []
    assert world.probe_calls == 0 and world.model_calls() == 0
