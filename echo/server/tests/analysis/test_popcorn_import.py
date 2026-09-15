"""Importing a saved popcorn session: deterministic, repeatable, no model call."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from dembrane.analysis.contracts import Origin, ScopeKind, RelationStatus, RevisionStatus
from dembrane.analysis.popcorn_import import (
    ImportReport,
    import_session,
    popcorn_lineage_key,
    stakeholder_lineage,
    tension_lineage_key,
)
from tests.analysis.test_writer_ownership import FakeWriters

PROJECT = "55555555-5555-4555-8555-555555555555"
C1 = "dddddddd-0000-4000-8000-000000000001"
LOOP = "eeeeeeee-0000-4000-8000-000000000009"

DESKS = "Nobody joins for the desks"
DESKS_QUOTE = "Nobody joins for the desks, honestly."
KNOT = "Keep the desks and nobody comes; drop them and there is nowhere to sit."


def session_state() -> dict[str, Any]:
    return {
        "version": 2,
        "run": 3,
        "order": [C1],
        "conversations": {
            C1: {
                "id": C1,
                "label": "Table 1",
                "created_at": "2026-09-03T09:00:00+00:00",
                "done": True,
                "items": [
                    {
                        "id": "p-c1-abcd1234",
                        "phrase": DESKS,
                        "kind": "observation",
                        "qualifiers": ["personal_experience"],
                        "verbatim": True,
                        "quoteId": "q1",
                    },
                    {"id": "p-c1-eeee5555", "phrase": "Where did the budget go", "question": True},
                ],
            }
        },
        "quotes": [{"id": "q1", "transcript": C1, "text": DESKS_QUOTE}],
        "analysis": {
            "tensions": {
                "tensions": [
                    {
                        "id": "x1",
                        "poleA": "Keep the desks",
                        "poleB": "Boil the kettle",
                        "narrative": KNOT,
                        "toResolve": "Which one goes first?",
                        "quoteIds": ["q1"],
                    }
                ]
            },
            "stakeholders": {
                "stakeholders": [
                    {
                        "id": "s1",
                        "name": "Members",
                        "role": "people who pay to be here",
                        "stake": "whether the space stays theirs",
                        "quoteIds": ["q1"],
                        "evidence": {"rung": "voiced"},
                        "weight": {"stake": 0.9, "mentions": 0.8},
                    },
                    {
                        "id": "s2",
                        "name": "Staff",
                        "role": "people who run the space",
                        "stake": "whether the work stays doable",
                        "quoteIds": [],
                        "evidence": {"rung": "named", "invokedBy": "Members"},
                        "weight": {"stake": 0.4, "mentions": 0.2},
                    },
                ],
                "relations": [
                    {
                        "id": "r1",
                        "between": ["s1", "s2"],
                        "label": "told after the fact",
                        "intensity": 0.7,
                        "sentiment": -0.4,
                        "unowned": True,
                        "detail": "Decisions arrive as announcements.",
                        "aspects": [
                            {"kind": "power", "note": "Staff decide first.", "quoteIds": ["q1"]}
                        ],
                    }
                ],
            },
        },
    }


def loop(state: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": LOOP,
        "project_id": PROJECT,
        "caps": {"kind": "popcorn"},
        "popcorn_state": state if state is not None else session_state(),
    }


async def run_import(store: FakeAnalysisStore, **kwargs: Any) -> ImportReport:
    report = ImportReport()
    await import_session(
        loop(kwargs.pop("state", None)),
        store=store,
        writers=FakeWriters(store),
        report=report,
        drain=None,
        **kwargs,
    )
    return report


def of_type(store: FakeAnalysisStore, type_id: str) -> list[Any]:
    return [r for r in store.revisions.values() if r.type == type_id]


@pytest.mark.asyncio
async def test_a_session_imports_its_phrases_tensions_and_groups() -> None:
    store = FakeAnalysisStore()
    report = await run_import(store)
    assert (report.phrases, report.tensions, report.stakeholders, report.relations) == (2, 1, 2, 1)
    assert report.sessions == 1 and report.conversations == 1

    phrases = {r.payload["phrase"]: r for r in of_type(store, "popcorn")}
    desks = phrases[DESKS]
    assert desks.status == RevisionStatus.PUBLISHED
    assert desks.provenance.origin == Origin.IMPORTED
    assert desks.provenance.recipe_id == "popcorn.legacy_phrases"
    assert desks.provenance.extra["legacy"] is True
    assert desks.provenance.extra["legacyLoopId"] == LOOP
    assert desks.provenance.extra["legacyPhraseId"] == "p-c1-abcd1234"
    assert desks.provenance.extra["kind"] == "observation"
    assert desks.payload["evidence"][0]["quotes"] == [DESKS_QUOTE]
    (ref,) = desks.provenance.source_refs
    # The session kept the quote, never the transcript it was checked against.
    assert (ref.conversation_id, ref.quote, ref.source_fingerprint) == (C1, DESKS_QUOTE, None)
    assert store.objects[desks.object_id].lineage_key == popcorn_lineage_key(C1, DESKS)
    assert phrases["Where did the budget go"].payload["question"] is True

    (tension,) = of_type(store, "tension")
    assert tension.payload["knot"] == KNOT and tension.payload["poleA"] == "Keep the desks"
    assert tension.payload["quotes"][0]["text"] == DESKS_QUOTE
    assert store.objects[tension.object_id].lineage_key == tension_lineage_key(
        "Keep the desks", "Boil the kettle"
    )
    # A saved tension never recorded which arguments hold its poles, so it has
    # no relationship, and the way to earn one is named on it.
    assert tension.provenance.extra["argumentRelations"] == "none_recorded"
    assert tension.provenance.extra["regenerate"] == "tensions"
    assert not [r for r in store.relations.values() if r.to_revision_id == tension.id]

    groups = {r.payload["name"]: r for r in of_type(store, "stakeholder")}
    assert groups["Members"].payload["rung"] == "voiced"
    assert groups["Members"].payload["weight"] == {"stake": 0.9, "mentions": 0.8}
    assert groups["Members"].payload["quotes"][0]["text"] == DESKS_QUOTE
    # The slide's `s1` is a position in a list; the group's name is its identity.
    assert groups["Staff"].payload["invokedBy"] == "Members"
    assert store.objects[groups["Staff"].object_id].lineage_key == stakeholder_lineage("Staff")

    (link,) = [r for r in store.relations.values() if r.type == "stakeholder_relation"]
    assert link.status == RelationStatus.PUBLISHED and link.run_id is None
    assert {link.from_revision_id, link.to_revision_id} == {
        groups["Members"].id,
        groups["Staff"].id,
    }
    assert link.attributes["label"] == "told after the fact"
    assert link.attributes["aspects"][0]["quotes"][0]["text"] == DESKS_QUOTE


@pytest.mark.asyncio
async def test_a_second_import_of_the_same_session_changes_nothing() -> None:
    store = FakeAnalysisStore()
    first = await run_import(store)
    before = {rid: copy.deepcopy(r) for rid, r in store.revisions.items()}
    relations = dict(store.relations)

    again = await run_import(store)
    assert again.revisions_written == 0
    assert again.scopes_claimed == 0 and again.scopes_transferred == 0
    assert set(store.revisions) == set(before)
    assert all(store.revisions[rid].content_hash == r.content_hash for rid, r in before.items())
    assert set(store.relations) == set(relations)
    assert first.revisions_written == len(before)


@pytest.mark.asyncio
async def test_the_import_hands_every_scope_to_the_executor() -> None:
    store = FakeAnalysisStore()
    report = await run_import(store)
    assert report.scopes_claimed == 3 and report.scopes_transferred == 3
    for recipe_id, scope_key in (
        ("popcorn", f"conversation:{C1}"),
        ("tensions", "project"),
        ("stakeholders", "project"),
    ):
        scope = await store.find_scope(
            project_id=PROJECT, kind=ScopeKind.PRODUCER, owner_id=recipe_id, scope_key=scope_key
        )
        assert scope is not None, (recipe_id, scope_key)
        assert str(scope.writer) == "analysis"
        # Claimed once and handed over once: two fence moves, no more.
        assert scope.writer_fence == 2


@pytest.mark.asyncio
async def test_an_import_left_with_the_legacy_writer_can_be_handed_over_later() -> None:
    store = FakeAnalysisStore()
    report = await run_import(store, transfer=False)
    assert report.scopes_claimed == 3 and report.scopes_transferred == 0
    scope = await store.find_scope(
        project_id=PROJECT,
        kind=ScopeKind.PRODUCER,
        owner_id="popcorn",
        scope_key=f"conversation:{C1}",
    )
    assert scope is not None and str(scope.writer) == "legacy"

    handed = await run_import(store)
    assert handed.revisions_written == 0 and handed.scopes_transferred == 3


@pytest.mark.asyncio
async def test_a_session_without_analysis_imports_only_its_phrases() -> None:
    state = session_state()
    state["analysis"] = None
    store = FakeAnalysisStore()
    report = await run_import(store, state=state)
    assert report.phrases == 2 and report.tensions == 0 and report.stakeholders == 0
    assert of_type(store, "tension") == [] and of_type(store, "stakeholder") == []
