"""The stakeholders recipe through the executor, with a scripted grounded call."""

from __future__ import annotations

from typing import Any
from dataclasses import replace

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, execute_inline
from dembrane.analysis.registry import register_recipe
from dembrane.analysis.contracts import Run, Relation, RunStatus, StepStatus, ObjectRevision
from tests.analysis.producer_fakes import C1, C2, PROJECT, ProducerWorld
from dembrane.analysis.recipes.services import SERVICES_KEY
from dembrane.analysis.recipes.stakeholders import RECIPE

TEXT_ONE = (
    "Ann: The members only hear about a decision once it is already made.\n"
    "Ann: Nobody joins for the desks, honestly."
)
TEXT_TWO = "Bob: We are told after the fact, every single time.\n"

MEMBERS_QUOTE = "The members only hear about a decision once it is already made."
STAFF_QUOTE = "We are told after the fact, every single time."


def group(
    name: str,
    *,
    rung: str = "voiced",
    stake: float = 0.9,
    mentions: float = 0.8,
    quotes: tuple[tuple[str, str], ...] = (),
    invoked_by: str | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": name,
        "role": "people who use the space week in week out",
        "stake": "whether decisions are made with them or about them",
        "rung": rung,
        "stakeWeight": stake,
        "mentionsWeight": mentions,
        "quotes": [{"transcript": tid, "text": text} for tid, text in quotes],
    }
    if invoked_by:
        entry["invokedBy"] = invoked_by
    return entry


def relation(between: list[str], *, aspect_quote: tuple[str, str] | None = None) -> dict[str, Any]:
    aspects = []
    if aspect_quote is not None:
        aspects.append(
            {
                "kind": "power",
                "note": "One group decides and the other hears about it later.",
                "quotes": [{"transcript": aspect_quote[0], "text": aspect_quote[1]}],
            }
        )
    return {
        "between": between,
        "label": "told after the fact",
        "intensity": 0.7,
        "sentiment": -0.4,
        "unowned": True,
        "detail": "Decisions arrive as announcements rather than as questions.",
        "aspects": aspects,
    }


def answer(groups: list[dict[str, Any]], relations: list[dict[str, Any]]) -> dict[str, Any]:
    return {"stakeholders": groups, "relations": relations}


def session(*answers: dict[str, Any]) -> tuple[ProducerWorld, FakeAnalysisStore, list[str]]:
    register_recipe(RECIPE, replace=True)
    world = ProducerWorld()
    world.add(C1, "Ann", TEXT_ONE, [], 1)
    world.add(C2, "Bob", TEXT_TWO, [], 2)
    world.answers = list(answers)  # type: ignore[attr-defined]
    return world, FakeAnalysisStore(), []


async def publish(
    world: ProducerWorld, store: FakeAnalysisStore, prompts: list[str]
) -> tuple[Run, FakeAnalysisStore]:
    answers = list(world.answers)  # type: ignore[attr-defined]

    async def generate(
        *,
        system_prompt: str,
        user_text: str,  # noqa: ARG001
        schema: dict[str, Any],  # noqa: ARG001
        thinking: bool = True,  # noqa: ARG001
    ) -> tuple[dict[str, Any], dict[str, int]]:
        prompts.append(system_prompt)
        return answers.pop(0), {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}

    deps = world.deps(Recorder())
    deps.services = {SERVICES_KEY: replace(world.services(), generate=generate)}
    outcome = await execute_inline(
        RunRequest(project_id=PROJECT, recipe_id="stakeholders", scope_key="project"),
        store=store,
        deps=deps,
    )
    return outcome.run, store


def objects(store: FakeAnalysisStore, run: Run) -> list[ObjectRevision]:
    assert run.output_manifest is not None
    return [store.revisions[o["revisionId"]] for o in run.output_manifest["objects"]]


def relations_of(store: FakeAnalysisStore, run: Run) -> list[Relation]:
    assert run.output_manifest is not None
    return [store.relations[r["relationId"]] for r in run.output_manifest["relations"]]


@pytest.mark.asyncio
async def test_the_session_publishes_groups_and_the_relations_between_them() -> None:
    world, store, prompts = session(
        answer(
            [
                group("Members", quotes=((C1, MEMBERS_QUOTE),)),
                group("Staff", rung="named", stake=0.4, mentions=0.2, quotes=((C2, STAFF_QUOTE),)),
            ],
            [relation(["Members", "Staff"], aspect_quote=(C1, MEMBERS_QUOTE))],
        )
    )
    run, store = await publish(world, store, prompts)
    assert run.status == RunStatus.READY, run.error

    revisions = {r.payload["name"]: r for r in objects(store, run)}
    assert sorted(revisions) == ["Members", "Staff"]
    members = revisions["Members"]
    assert members.type == "stakeholder"
    assert members.payload["rung"] == "voiced"
    assert members.payload["weight"] == {"stake": 0.9, "mentions": 0.8}
    assert members.payload["quotes"][0]["text"] == MEMBERS_QUOTE
    assert members.payload["quotes"][0]["conversationId"] == C1
    assert members.payload["quotes"][0]["location"]["basis"] == "collapsed-casefold-v1"
    assert revisions["Staff"].payload["rung"] == "named"
    (ref,) = members.provenance.source_refs
    assert (ref.conversation_id, ref.quote) == (C1, MEMBERS_QUOTE)
    assert ref.source_fingerprint == next(t.text_hash for t in world.transcripts if t.id == C1)
    assert store.objects[members.object_id].lineage_key.startswith("stakeholders/project/name:")
    refs = members.embedding_refs or {}
    assert refs["projectionVersion"] == "name-role-stake-v1" and refs["embeddingId"]

    (link,) = relations_of(store, run)
    assert link.type == "stakeholder_relation" and str(link.basis) == "extracted"
    assert {link.from_revision_id, link.to_revision_id} == {members.id, revisions["Staff"].id}
    assert link.attributes["label"] == "told after the fact"
    assert link.attributes["intensity"] == 0.7 and link.attributes["sentiment"] == -0.4
    assert link.attributes["unowned"] is True
    assert link.attributes["aspects"][0]["kind"] == "power"
    assert link.attributes["aspects"][0]["quotes"][0]["text"] == MEMBERS_QUOTE

    steps = {s.step_key: s for s in await store.get_steps(run.id)}
    assert sorted(steps) == ["corpus", "embed", "gates", "stakeholders:first"]
    assert all(s.status == StepStatus.COMPLETED for s in steps.values())
    (gate,) = steps["gates"].validation
    assert gate["check"] == "stakeholder-gates" and gate["status"] == "passed"
    assert gate["evidence"]["flags"] == [] and gate["evidence"]["left"] == []
    assert gate["evidence"]["quotesVerified"] == 2
    assert run.metrics["modelCalls"] == 1 and run.metrics["stakeholders"] == 2
    assert run.metrics["relations"] == 1 and len(prompts) == 1


@pytest.mark.asyncio
async def test_a_joined_name_goes_back_to_the_model_once_with_its_flags() -> None:
    world, store, prompts = session(
        answer(
            [
                group("Members/AI", quotes=((C1, MEMBERS_QUOTE),)),
                group("Staff", quotes=((C2, STAFF_QUOTE),)),
            ],
            [relation(["Members/AI", "Staff"], aspect_quote=(C1, MEMBERS_QUOTE))],
        ),
        answer(
            [
                group("Members", quotes=((C1, MEMBERS_QUOTE),)),
                group("Staff", quotes=((C2, STAFF_QUOTE),)),
            ],
            [relation(["Members", "Staff"], aspect_quote=(C1, MEMBERS_QUOTE))],
        ),
    )
    run, store = await publish(world, store, prompts)
    assert run.status == RunStatus.READY, run.error
    assert sorted(r.payload["name"] for r in objects(store, run)) == ["Members", "Staff"]
    assert len(prompts) == 2 and "joins two groups on one card" in prompts[1]
    assert "Your previous answer failed these checks" in prompts[1]
    steps = {s.step_key for s in await store.get_steps(run.id)}
    assert {"stakeholders:first", "stakeholders:retry"} <= steps
    (gate,) = next(s for s in await store.get_steps(run.id) if s.step_key == "gates").validation
    assert len(gate["evidence"]["flags"]) == 1 and gate["evidence"]["left"] == []
    assert run.metrics["modelCalls"] == 2


@pytest.mark.asyncio
async def test_a_quote_nobody_said_is_dropped_and_its_aspect_with_it() -> None:
    """Absence from the corpus is never evidence: the group keeps its rung and
    loses only what the transcripts do not hold."""
    world, store, prompts = session(
        answer(
            [
                group("Members", quotes=((C1, "a line nobody said in this room"),)),
                group("Staff", rung="inferred", quotes=()),
            ],
            [relation(["Members", "Staff"], aspect_quote=(C1, "another line nobody said"))],
        )
    )
    run, store = await publish(world, store, prompts)
    assert run.status == RunStatus.READY, run.error
    revisions = {r.payload["name"]: r for r in objects(store, run)}
    assert revisions["Members"].payload["quotes"] == []
    assert revisions["Members"].provenance.source_refs == ()
    assert revisions["Staff"].payload["rung"] == "inferred"
    (link,) = relations_of(store, run)
    # No quote, no aspect; the relation itself is what the model reported.
    assert link.attributes["aspects"] == []
    gate = next(s for s in await store.get_steps(run.id) if s.step_key == "gates").validation[0]
    assert gate["evidence"]["quotesRejected"] == 2 and gate["evidence"]["quotesVerified"] == 0
    assert len(prompts) == 1
