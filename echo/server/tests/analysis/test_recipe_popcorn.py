"""The popcorn recipe through the executor, on the in-memory store.

The session's phrases are the input, so no model is called here: the tick has
already read the conversation, and this is how what it read becomes objects.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, execute_inline
from dembrane.analysis.registry import register_recipe
from dembrane.analysis.contracts import Run, RunStatus, StepStatus, ObjectRevision
from tests.analysis.producer_fakes import C1, C2, PROJECT, ProducerWorld
from dembrane.analysis.recipes.popcorn import (
    RECIPE,
    SOURCES_KEY,
    ConversationPhrases,
    scope_key_for,
    phrase_records,
)

TEXT_ONE = (
    "Ann: Nobody joins for the desks, honestly.\n"
    "Ann: The kettle is the real reception here.\n"
    "Ann: Where did the budget go, does anyone know?"
)
TEXT_TWO = "Bob: Quiet is a service we sell, and we forget it.\n"

DESKS = "Nobody joins for the desks"
KETTLE = "The kettle is the real reception"
BUDGET = "Where did the budget go"
QUIET = "Quiet is a service we sell"

QUOTES: dict[str, dict[str, Any]] = {
    "q1": {"id": "q1", "transcript": C1, "text": "Nobody joins for the desks, honestly."},
    "q2": {"id": "q2", "transcript": C1, "text": "The kettle is the real reception here."},
    "q3": {"id": "q3", "transcript": C2, "text": "Quiet is a service we sell"},
}


def item(phrase: str, quote_id: str | None = None, **extra: Any) -> dict[str, Any]:
    """One item as the tick's state holds it."""
    slug = "".join(ch for ch in phrase.lower() if ch.isalnum())[:8]
    entry: dict[str, Any] = {"id": f"p-{slug}", "phrase": phrase, **extra}
    if quote_id:
        entry["quoteId"] = quote_id
    return entry


class _Sources:
    """The tick's own source, scripted: one conversation as the session holds it."""

    def __init__(self, *conversations: ConversationPhrases) -> None:
        self.by_id = {c.conversation_id: c for c in conversations}
        self.reads = 0

    def set(self, conversation: ConversationPhrases) -> None:
        self.by_id[conversation.conversation_id] = conversation

    async def conversation(
        self,
        project_id: str,  # noqa: ARG002
        conversation_id: str,
    ) -> ConversationPhrases | None:
        self.reads += 1
        return self.by_id.get(conversation_id)


def conversation(
    conversation_id: str, text: str, entries: list[dict[str, Any]], label: str = "Ann"
) -> ConversationPhrases:
    return ConversationPhrases(
        conversation_id=conversation_id,
        text=text,
        phrases=tuple(phrase_records(entries, QUOTES)),
        label=label,
        created_at="2026-09-16T10:00:00Z",
        prompts={"extract": "popcorn-v1.7", "validate": "popcorn-validate"},
    )


def setup(*conversations: ConversationPhrases) -> tuple[ProducerWorld, FakeAnalysisStore, _Sources]:
    register_recipe(RECIPE, replace=True)
    return ProducerWorld(), FakeAnalysisStore(), _Sources(*conversations)


async def publish(
    world: ProducerWorld, store: FakeAnalysisStore, sources: _Sources, conversation_id: str
) -> Run:
    """One inline run, the way the tick makes it."""
    deps = world.deps(Recorder())
    deps.services = {**deps.services, SOURCES_KEY: sources}
    outcome = await execute_inline(
        RunRequest(
            project_id=PROJECT, recipe_id="popcorn", scope_key=scope_key_for(conversation_id)
        ),
        store=store,
        deps=deps,
    )
    assert outcome.run.status == RunStatus.READY, outcome.run.error
    return outcome.run


def published(store: FakeAnalysisStore, run: Run) -> list[ObjectRevision]:
    assert run.output_manifest is not None
    return [store.revisions[o["revisionId"]] for o in run.output_manifest["objects"]]


def by_phrase(revisions: list[ObjectRevision]) -> dict[str, ObjectRevision]:
    return {r.payload["phrase"]: r for r in revisions}


@pytest.mark.asyncio
async def test_a_conversation_publishes_its_phrases_with_evidence_and_vectors() -> None:
    world, store, sources = setup(
        conversation(
            C1,
            TEXT_ONE,
            [
                item(DESKS, "q1", kind="observation", qualifiers=["personal_experience"]),
                item(BUDGET, "q2", question=True, kind="question"),
            ],
        )
    )
    run = await publish(world, store, sources, C1)

    revisions = published(store, run)
    assert len(revisions) == 2 and {r.type for r in revisions} == {"popcorn"}
    desks = by_phrase(revisions)[DESKS]
    assert desks.payload["question"] is False
    assert desks.payload["evidence"] == [
        {
            "conversationId": C1,
            "label": "Ann",
            "createdAt": "2026-09-16T10:00:00Z",
            "quotes": ["Nobody joins for the desks, honestly."],
        }
    ]
    # The phrase is in the transcript word for word, so the room may read it in
    # quotation marks; what the second pass made of it travels alongside.
    assert desks.provenance.extra["verbatim"] is True
    assert desks.provenance.extra["kind"] == "observation"
    assert desks.provenance.extra["qualifiers"] == ["personal_experience"]
    assert desks.provenance.extra["quoteId"] == "q1"
    assert desks.provenance.extra["phraseId"] == "p-nobodyjo"
    assert desks.provenance.recipe_id == "popcorn"
    (ref,) = desks.provenance.source_refs
    assert ref.conversation_id == C1 and ref.quote == "Nobody joins for the desks, honestly."
    assert ref.location == {"offset": 5, "basis": "collapsed-casefold-v1"}
    assert ref.source_fingerprint

    assert by_phrase(revisions)[BUDGET].payload["question"] is True
    refs = desks.embedding_refs or {}
    assert refs["projectionVersion"] == "phrase-v1" and refs["embeddingId"] in store.embeddings
    assert store.objects[desks.object_id].lineage_key.startswith(f"popcorn/conversation:{C1}/{C1}:")

    steps = {s.step_key: s for s in await store.get_steps(run.id)}
    assert sorted(steps) == ["collect", "embed", "ground"]
    assert all(s.status == StepStatus.COMPLETED for s in steps.values())
    (grounding,) = steps["ground"].validation
    assert grounding["check"] == "quote-verbatim"
    assert grounding["evidence"] == {
        "phrases": 2,
        "withQuote": 2,
        "quotesNotFound": 0,
        "verbatim": 2,
    }
    assert {c["check"] for c in run.checks} >= {"schema", "references", "embeddings-durable"}
    # The tick already called the model: this run calls nothing.
    assert world.model_calls() == 0 and run.metrics["modelCalls"] == 0
    assert run.metrics["phrases"] == 2 and run.metrics["embeddingsComputed"] == 2


@pytest.mark.asyncio
async def test_republishing_one_conversation_leaves_another_conversations_objects() -> None:
    world, store, sources = setup(
        conversation(C1, TEXT_ONE, [item(DESKS, "q1")]),
        conversation(C2, TEXT_TWO, [item(QUIET, "q3")], label="Bob"),
    )
    first = await publish(world, store, sources, C1)
    second = await publish(world, store, sources, C2)
    kept = published(store, second)[0]

    # C1 says something else now; C2's scope, output and object are untouched.
    sources.set(conversation(C1, TEXT_ONE, [item(KETTLE, "q2")]))
    again = await publish(world, store, sources, C1)
    assert again.scope_id == first.scope_id and again.scope_id != second.scope_id
    assert store.objects[kept.object_id].current_revision_id == kept.id
    assert store.scopes[second.scope_id].current_run_id == second.id
    assert [r.payload["phrase"] for r in published(store, again)] == [KETTLE]
    # The phrase that left is still readable in its own revision.
    assert store.revisions[published(store, first)[0].id].payload["phrase"] == DESKS


@pytest.mark.asyncio
async def test_a_rewritten_phrase_is_a_new_object_and_an_unchanged_one_is_reused() -> None:
    world, store, sources = setup(conversation(C1, TEXT_ONE, [item(DESKS, "q1")]))
    first = await publish(world, store, sources, C1)
    before = published(store, first)[0]

    # Nothing changed: the refresh reuses the ready output and computes nothing.
    again = await publish(world, store, sources, C1)
    assert again.reused_run_id == first.id and again.metrics.get("modelCalls") == 0
    assert len(store.revisions) == 1

    # The second pass rewrote the question: a new object, and the old revision
    # stays exactly as the room read it.
    sources.set(conversation(C1, TEXT_ONE, [item("Who joins for the desks", "q1")]))
    third = await publish(world, store, sources, C1)
    after = published(store, third)[0]
    assert after.object_id != before.object_id
    assert store.revisions[before.id].payload["phrase"] == DESKS


@pytest.mark.asyncio
async def test_a_quote_the_transcript_no_longer_holds_leaves_the_evidence() -> None:
    world, store, sources = setup(
        conversation(C1, "Ann: Only this line is left.", [item(DESKS, "q1")])
    )
    run = await publish(world, store, sources, C1)
    (revision,) = published(store, run)
    assert revision.payload["evidence"][0]["quotes"] == []
    assert revision.provenance.source_refs == ()
    assert revision.provenance.extra.get("quoteId") is None
    assert revision.provenance.extra["verbatim"] is False
    steps = {s.step_key: s for s in await store.get_steps(run.id)}
    (grounding,) = steps["ground"].validation
    assert grounding["evidence"]["quotesNotFound"] == 1 and grounding["evidence"]["withQuote"] == 0
