"""The tensions recipe through the executor, over raw or deduplicated
arguments, on the in-memory store with a scripted judge."""

from __future__ import annotations

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, request_run, execute_inline
from dembrane.analysis.registry import InvalidRecipeRequest
from dembrane.analysis.contracts import Run, Relation, RunStatus, ObjectRevision
from tests.analysis.producer_fakes import (
    C1,
    C2,
    C3,
    RECORD,
    PROJECT,
    POLE_FOR,
    OFF_RECORD,
    RECORDINGS,
    POLE_AGAINST,
    MERGED_RECORD,
    ProducerWorld,
    merge_all,
)


def _request(input_set: str | None = "arguments", **kwargs: object) -> RunRequest:
    parameters = {"input_set": input_set} if input_set is not None else {}
    return RunRequest(project_id=PROJECT, recipe_id="tensions", scope_key="project", parameters=parameters, **kwargs)  # type: ignore[arg-type]


async def _inline(store: FakeAnalysisStore, world: ProducerWorld, key: str, **kwargs: object) -> Run:
    outcome = await execute_inline(_request(idempotency_key=key, **kwargs), store=store, deps=world.deps(Recorder()))  # type: ignore[arg-type]
    return outcome.run


def _objects(store: FakeAnalysisStore, run: Run) -> list[ObjectRevision]:
    assert run.output_manifest is not None
    return [store.revisions[o["revisionId"]] for o in run.output_manifest["objects"]]


def _relations(store: FakeAnalysisStore, run: Run) -> list[Relation]:
    assert run.output_manifest is not None
    return [store.relations[r["relationId"]] for r in run.output_manifest["relations"]]


def _pinned(store: FakeAnalysisStore, run: Run) -> Run:
    assert run.input_manifest is not None
    return store.runs[run.input_manifest["dependencies"]["arguments"]["runId"]]


@pytest.mark.asyncio
async def test_tensions_over_raw_arguments_link_both_poles_to_exact_argument_revisions() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    run = await _inline(store, world, "t1")
    assert run.status == RunStatus.READY and run.parameters == {"input_set": "arguments"}
    arguments = _pinned(store, run)
    assert arguments.recipe_id == "arguments" and arguments.status == RunStatus.READY
    assert run.input_manifest["dependencies"]["arguments"]["manifestHash"] == arguments.output_manifest["contentHash"]  # type: ignore[index]
    by_statement = {store.revisions[o["revisionId"]].payload["statement"]: o["revisionId"] for o in arguments.output_manifest["objects"]}  # type: ignore[index]
    assert {r.recipe_id for r in store.runs.values()} == {"arguments", "tensions"}

    (tension,) = _objects(store, run)
    payload = tension.payload
    assert (payload["poleA"], payload["poleB"]) == (POLE_FOR, POLE_AGAINST)
    assert payload["knot"].startswith("Record it") and payload["toResolve"].endswith("?")
    assert [(q["conversationId"], q["pole"]) for q in payload["quotes"]] == [(C1, "A"), (C3, "A"), (C2, "B")]
    assert all(q["location"]["basis"] == "collapsed-casefold-v1" for q in payload["quotes"])
    # The verifier's own quote never reaches the tension.
    assert all(q["text"] != "a line nobody said" for q in payload["quotes"])

    relations = sorted(_relations(store, run), key=lambda r: (r.type, store.revisions[r.from_revision_id].payload["statement"]))
    assert [(r.type, r.from_revision_id, r.to_revision_id) for r in relations] == [
        ("supports_pole_a", by_statement[RECORD], tension.id),
        ("supports_pole_a", by_statement[RECORDINGS], tension.id),
        ("supports_pole_b", by_statement[OFF_RECORD], tension.id),
    ]
    assert all(str(r.basis) == "extracted" and r.attributes["rationale"] == "both are held" for r in relations)
    assert relations[2].attributes["quotes"][0]["conversationId"] == C2
    assert sorted(tension.provenance.input_revision_ids) == sorted(r.from_revision_id for r in relations)
    transcripts = {t.id: t.text_hash for t in world.transcripts}
    assert all(ref.source_fingerprint == transcripts[ref.conversation_id] for ref in tension.provenance.source_refs)

    checks = {c["check"]: c for c in run.checks}
    assert checks["evidence-verbatim"]["evidence"]["positions"] == 8
    assert checks["both-poles-supported"]["status"] == "passed"
    assert checks["tension-coverage"]["evidence"]["status"] == "ok" and checks["tension-coverage"]["evidence"]["suggestion"] is None
    stages = {name: world.stage_calls(name) for name in ("framing", "collisions", "verify", "dedupe", "write")}
    assert stages == {"framing": 1, "collisions": 8, "verify": 2, "dedupe": 1, "write": 1}
    assert run.metrics["modelCalls"] == 13 and run.metrics["tensions"] == 1
    assert run.metrics["supports_pole_a"] == 2 and run.metrics["supports_pole_b"] == 1


@pytest.mark.asyncio
async def test_tensions_over_deduplicated_arguments_link_the_deduplicated_revisions() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.verifier = merge_all(MERGED_RECORD)
    run = await _inline(store, world, "t1", input_set="deduplicated_arguments")
    assert run.status == RunStatus.READY
    dedup = _pinned(store, run)
    assert dedup.recipe_id == "deduplicated_arguments"
    dedup_ids = {o["revisionId"] for o in dedup.output_manifest["objects"]}  # type: ignore[index]

    (tension,) = _objects(store, run)
    relations = _relations(store, run)
    assert all(r.from_revision_id in dedup_ids for r in relations)
    pole_a = [store.revisions[r.from_revision_id].payload["statement"] for r in relations if r.type == "supports_pole_a"]
    pole_b = [store.revisions[r.from_revision_id].payload["statement"] for r in relations if r.type == "supports_pole_b"]
    assert (pole_a, pole_b) == ([MERGED_RECORD], [OFF_RECORD])
    # The consolidated argument's evidence reaches its members' conversations.
    assert {q["conversationId"] for q in tension.payload["quotes"] if q["pole"] == "A"} == {C1, C3}
    verify_users = [user for stage, user in world.judge_calls if stage == "verify"]
    assert len(verify_users) == 1 and all(f"TRANSCRIPT id: {c}" in verify_users[0] for c in (C1, C2, C3))
    assert "Ann" not in verify_users[0].split("THE PAIR:")[1]


@pytest.mark.asyncio
async def test_too_little_evidence_is_a_ready_result_that_suggests_refreshing_arguments() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.transcripts = world.transcripts[:1]
    run = await _inline(store, world, "t1")
    assert run.status == RunStatus.READY and _objects(store, run) == []
    coverage = next(c for c in run.checks if c["check"] == "tension-coverage")
    assert coverage["evidence"]["status"] == "insufficient_coverage"
    assert coverage["evidence"]["suggestion"] == "refresh_arguments" and "at least 2" in coverage["message"]
    assert world.judge_calls == [] and run.metrics["modelCalls"] == 0


@pytest.mark.asyncio
async def test_zero_tensions_is_a_valid_result() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    world.transcripts = [t for t in world.transcripts if t.id != C2]
    run = await _inline(store, world, "t1")
    assert run.status == RunStatus.READY and _objects(store, run) == [] and _relations(store, run) == []
    assert world.stage_calls("collisions") == 5 and world.stage_calls("verify") == 0


@pytest.mark.asyncio
async def test_refresh_reuses_the_tensions_and_regenerate_asks_the_judge_again() -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    first = await _inline(store, world, "t1")
    calls = len(world.judge_calls)
    reuse = await request_run(_request(idempotency_key="t2"), store=store, deps=world.deps(Recorder()))
    assert reuse.outcome == "reused" and reuse.run.reused_run_id == first.id and len(world.judge_calls) == calls

    again = await _inline(store, world, "g1", mode="regenerate")
    assert again.status == RunStatus.READY and len(world.judge_calls) == 2 * calls
    (before,), (after,) = _objects(store, first), _objects(store, again)
    # Same arguments on the same poles, same words: the same tension revision.
    assert after.id == before.id and again.metrics["objectsReused"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("parameters", [None, "raw", "both"])
async def test_the_input_set_is_required_and_named(parameters: str | None) -> None:
    world, store = ProducerWorld.recording_debate(), FakeAnalysisStore()
    with pytest.raises(InvalidRecipeRequest):
        await request_run(_request(parameters), store=store, deps=world.deps(Recorder()))
    assert store.runs == {} and world.model_calls() == 0
