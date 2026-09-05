from __future__ import annotations

import asyncio
from typing import Any

import pytest

from dembrane.popcorn.enrichment import (
    kind_from,
    enrich_item,
    hedge_added,
    question_ok,
    apply_results,
    evidence_from,
)

TRANSCRIPT = """Some environments make junior staff feel they have nothing to add.
Nobody joins for the desks. I could get a desk anywhere cheaper.
Knowing at what stage to introduce the tools, that is the thing, isn't it?"""


def test_evidence_counts_only_when_verbatim() -> None:
    good = evidence_from(
        {
            "grounded": True,
            "quote": "nobody joins for the desks. I could get a desk",
            "reason": "r",
        },
        "Nobody joins for the desks",
        TRANSCRIPT,
    )
    assert good["grounded"] is True and good["quote"].startswith("nobody joins")
    # The model says grounded but the passage is not in the transcript: unrooted.
    bad = evidence_from(
        {"grounded": True, "quote": "nobody joins for the chairs", "reason": "r"}, "x", TRANSCRIPT
    )
    assert bad["grounded"] is False and bad["quote"] == ""
    short = evidence_from({"grounded": True, "quote": "desks.", "reason": "r"}, "x", TRANSCRIPT)
    assert short["grounded"] is False


def test_hedge_added_names_the_modal_the_source_lacks() -> None:
    quote = "Some environments make junior staff feel they have nothing to add."
    assert hedge_added(
        "Environments can make junior staff feel they have nothing to add", quote
    ) == ["can"]
    assert (
        hedge_added("Some environments make junior staff feel they have nothing to add", quote)
        == []
    )
    ev = evidence_from(
        {"grounded": True, "quote": quote, "reason": "r"},
        "Environments can make junior staff feel they have nothing to add",
        TRANSCRIPT,
    )
    assert ev["hedge_added"] == ["can"]


def test_kind_from_scrubs_names_and_rejects_unknown_kinds() -> None:
    kind = kind_from(
        {
            "kind": "objection",
            "qualifiers": ["tentative", "bogus"],
            "question_form": False,
            "target": "Priya's plan",
            "reason": "answers what Tom proposed",
        },
        {"Priya", "Tom"},
    )
    assert kind == {
        "kind": "objection",
        "qualifiers": ["tentative"],
        "question": False,
        "target": "a participant plan",
        "reason": "answers what a participant proposed",
    }
    with pytest.raises(ValueError):
        kind_from({"kind": "vibe"}, set())


def test_question_ok_is_the_contract_plus_the_mark() -> None:
    assert question_ok("At what stage do we introduce the tools?")
    assert not question_ok("At what stage do we introduce the tools")
    assert not question_ok('Is "this" the stage?')
    assert not question_ok(" ".join(["w"] * 14) + "?")


def _calls(
    question_rewrite: str = "At what stage do we introduce the tools?",
) -> tuple[list[str], dict[str, Any]]:
    log: list[str] = []

    async def validate(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        log.append("validate")
        return {
            "grounded": True,
            "quote": "Nobody joins for the desks. I could get a desk",
            "reason": "r",
        }

    async def classify(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        log.append("classify")
        return {
            "kind": "question",
            "qualifiers": [],
            "question_form": False,
            "target": "",
            "reason": "asks",
        }

    async def rewrite(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        log.append("rewrite")
        return {"phrase": question_rewrite}

    return log, {"validate": validate, "classify": classify, "rewrite": rewrite}


def test_enrich_item_rewrites_a_question_written_as_a_statement() -> None:
    log, calls = _calls()
    item = {"id": "p1", "phrase": "Knowing at what stage to introduce the tools", "weight": 1}
    result = asyncio.run(
        enrich_item(item, transcript_id="t1", transcript=TRANSCRIPT, names=set(), **calls)
    )
    assert log == ["validate", "classify", "rewrite"]
    assert result["kind"]["question"] is True
    assert (
        result["rewritten"] == "At what stage do we introduce the tools"
    )  # the mark is the deck's
    assert result["errors"] == []


def test_enrich_item_keeps_the_statement_when_the_rewrite_fails_the_gate() -> None:
    _, calls = _calls(question_rewrite="not a question")
    item = {"id": "p1", "phrase": "Knowing at what stage to introduce the tools", "weight": 1}
    result = asyncio.run(
        enrich_item(item, transcript_id="t1", transcript=TRANSCRIPT, names=set(), **calls)
    )
    assert "rewritten" not in result and result["kind"]["question"] is False


def test_enrich_item_survives_one_dead_call() -> None:
    _, calls = _calls()

    async def broken(**kwargs: Any) -> dict[str, Any]:  # noqa: ARG001
        raise RuntimeError("quota")

    calls["validate"] = broken
    item = {"id": "p1", "phrase": "Nobody joins for the desks", "weight": 1}
    result = asyncio.run(
        enrich_item(item, transcript_id="t1", transcript=TRANSCRIPT, names=set(), **calls)
    )
    assert "evidence" not in result and result["kind"]["kind"] == "question"
    assert result["errors"] == ["evidence: quota"]


def test_apply_results_writes_once_and_skips_a_phrase_that_moved() -> None:
    items = [
        {"id": "p1", "phrase": "Nobody joins for the desks", "weight": 2, "quoteId": "q9"},
        {"id": "p2", "phrase": "A phrase the pass never saw", "weight": 1},
        {"id": "p3", "phrase": "Knowing at what stage to introduce the tools", "weight": 1},
    ]
    results = [
        {
            "id": "p1",
            "phrase": "Nobody joins for the desks",
            "errors": [],
            "evidence": {
                "grounded": False,
                "quote": "",
                "hedge_added": [],
                "reason": "paraphrase too loose",
            },
            "kind": {
                "kind": "observation",
                "qualifiers": ["personal_experience"],
                "question": False,
                "target": "",
                "reason": "r",
            },
        },
        {
            "id": "p2",
            "phrase": "an older wording",
            "errors": [],
            "evidence": {
                "grounded": True,
                "quote": "Nobody joins for the desks.",
                "hedge_added": [],
                "reason": "r",
            },
        },
        {
            "id": "p3",
            "phrase": "Knowing at what stage to introduce the tools",
            "errors": ["evidence: quota"],
            "kind": {
                "kind": "question",
                "qualifiers": [],
                "question": True,
                "target": "",
                "reason": "r",
            },
            "rewritten": "At what stage do we introduce the tools",
        },
    ]
    registered: list[str] = []

    def register(tid: str, text: str) -> str:
        registered.append(f"{tid}:{text}")
        return "q1"

    stats = apply_results(items, results, transcript_id="t1", register=register)
    assert stats == {"rooted": 0, "classified": 2, "rewritten": 1}
    assert registered == []
    # An unrooted phrase loses a stale quote id and keeps its kind.
    assert "quoteId" not in items[0] and items[0]["kind"] == "observation"
    assert items[0]["qualifiers"] == ["personal_experience"] and items[0]["question"] is False
    assert items[0]["review"] == {"evidence": "paraphrase too loose", "kind": "r"}
    # A phrase whose wording moved under the pass is left alone.
    assert items[1] == {"id": "p2", "phrase": "A phrase the pass never saw", "weight": 1}
    # The rewritten question keeps its old wording for the host, and its error.
    assert items[2]["phrase"] == "At what stage do we introduce the tools"
    assert items[2]["question"] is True
    assert items[2]["review"]["was"] == "Knowing at what stage to introduce the tools"
    assert items[2]["review"]["errors"] == ["evidence: quota"]


def test_a_rewrite_that_carries_a_name_is_refused() -> None:
    _, calls = _calls(question_rewrite="Should Alice lead the group?")
    item = {"id": "p1", "phrase": "Whether the newcomer should lead", "weight": 1}
    result = asyncio.run(
        enrich_item(item, transcript_id="t1", transcript=TRANSCRIPT, names={"Alice"}, **calls)
    )
    assert "rewritten" not in result and result["kind"]["question"] is False
