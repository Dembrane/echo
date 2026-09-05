from __future__ import annotations

import asyncio
from typing import Any

from dembrane.popcorn.analysis import QuoteBook
from dembrane.popcorn.tensions import (
    WRITE_SCHEMA,
    DEDUPE_SCHEMA,
    HANDED_SCHEMA,
    VERIFY_SCHEMA,
    POSITIONS_SCHEMA,
    COLLISIONS_SCHEMA,
    run_pipeline,
    trim_positions,
)

T1 = "We should record everything so nothing is lost. The notes never capture it."
T2 = "I would not speak freely on a permanent record. Some things stay in the room."
PROMPTS = {
    n: f"[{n}]"
    for n in ("positions", "collisions", "tension-verify", "tension-write", "tensions-handed")
}


def _generate(log: list[str], *, long_knot_first: bool = False):
    writes = {"n": 0}

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            log.append("handed")
            return {
                "handed": [
                    {
                        "text": "capture vs privacy",
                        "quote": "x",
                        "transcript": "t1",
                        "response": "argued",
                        "status": "argued",
                    }
                ]
            }
        if schema is POSITIONS_SCHEMA:
            tid = "t1" if "id: t1" in user_text else "t2"
            log.append(f"positions:{tid}")
            if tid == "t1":
                return {
                    "positions": [
                        {
                            "position": "record every conversation",
                            "holder": "a facilitator",
                            "kind": "want",
                            "hedged": False,
                            "quote": "record everything so nothing is lost",
                        },
                        {
                            "position": "notes are not enough",
                            "holder": "a facilitator",
                            "kind": "value",
                            "hedged": False,
                            "quote": "The notes never capture it",
                        },
                    ]
                }
            return {
                "positions": [
                    {
                        "position": "no permanent record",
                        "holder": "a participant",
                        "kind": "constraint",
                        "hedged": False,
                        "quote": "would not speak freely on a permanent record",
                    },
                ]
            }
        if schema is COLLISIONS_SCHEMA:
            focal = user_text.rsplit("FOCAL POSITION: ", 1)[1].strip()
            log.append(f"collisions:{focal}")
            return (
                {"collides": [{"id": "P3", "why": "one pays with candour", "zero_sum": 0.9}]}
                if focal == "P1"
                else {"collides": []}
            )
        if schema is VERIFY_SCHEMA:
            log.append("verify")
            assert "WHAT THE ROOMS WERE HANDED" in user_text and "capture vs privacy" in user_text
            return {
                "valid": True,
                "why": "both held",
                "poleA": "record every conversation",
                "poleB": "no permanent record",
                "quotesA": ["record everything so nothing is lost", "not in any transcript"],
                "quotesB": ["would not speak freely on a permanent record"],
            }
        if schema is DEDUPE_SCHEMA:
            log.append("dedupe")
            return {"same_as": "", "why": ""}
        if schema is WRITE_SCHEMA:
            writes["n"] += 1
            log.append("write" + (":retry" if "failed these checks" in system_prompt else ""))
            if long_knot_first and writes["n"] == 1:
                return {
                    "poleA": "",
                    "poleB": "",
                    "knot": " ".join(["word"] * 25),
                    "toResolve": "Which one?",
                }
            return {
                "poleA": "record every conversation",
                "poleB": "no permanent record",
                "knot": "Record it and people stop thinking out loud; don't, and the good bits are gone.",
                "toResolve": "Which conversations are recorded, and who decides?",
            }
        raise AssertionError("unexpected schema")

    return generate


def test_pipeline_finds_the_cross_table_pair_and_registers_its_quotes() -> None:
    log: list[str] = []
    book = QuoteBook({"t1": T1, "t2": T2})
    result = asyncio.run(
        run_pipeline(
            {"t1": T1, "t2": T2}, book, generate=_generate(log), prompts=PROMPTS, concurrency=2
        )
    )
    tensions = result["tensions"]["tensions"]
    assert len(tensions) == 1
    t = tensions[0]
    assert (
        t["id"] == "x1"
        and t["poleA"] == "record every conversation"
        and t["poleB"] == "no permanent record"
    )
    assert t["knot"].startswith("Record it") and t["toResolve"].endswith("?")
    # Two quotes registered, one per transcript; the invented one was dropped.
    assert t["quoteIds"] == ["q1", "q2"]
    assert [q["transcript"] for q in book.quotes] == ["t1", "t2"]
    assert result["gate_flags"] == []
    counts = result["counts"]
    assert counts["positions"] == 3 and counts["found_positions"] == 3
    assert counts["candidates"] == 1 and counts["found_pairs"] == 1 and counts["cross_table"] == 1
    assert counts["verified"] == 1 and counts["kept"] == 1 and counts["handed"] == 1
    # One call per stage per unit: two positions calls, three collisions, one verify, one write, no dedupe for the first.
    assert sorted(c for c in log if c.startswith("positions")) == ["positions:t1", "positions:t2"]
    assert log.count("verify") == 1 and log.count("write") == 1 and "dedupe" not in log


def test_pipeline_sends_a_long_knot_back_once() -> None:
    log: list[str] = []
    book = QuoteBook({"t1": T1, "t2": T2})
    result = asyncio.run(
        run_pipeline(
            {"t1": T1, "t2": T2},
            book,
            generate=_generate(log, long_knot_first=True),
            prompts=PROMPTS,
        )
    )
    assert log.count("write") == 1 and log.count("write:retry") == 1
    assert result["tensions"]["tensions"][0]["knot"].startswith("Record it")
    assert result["gate_flags"] == []


def test_pipeline_with_nothing_colliding_writes_nothing() -> None:
    async def quiet(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            return {"handed": []}
        if schema is POSITIONS_SCHEMA:
            return {
                "positions": [
                    {"position": "p", "holder": "h", "kind": "want", "hedged": False, "quote": "x"}
                ]
            }
        if schema is COLLISIONS_SCHEMA:
            return {"collides": []}
        raise AssertionError("nothing to verify or write")

    book = QuoteBook({"t1": T1})
    result = asyncio.run(run_pipeline({"t1": T1}, book, generate=quiet, prompts=PROMPTS))
    assert result["tensions"] == {"tensions": []} and book.quotes == []


def test_trim_keeps_each_transcripts_firmest_positions() -> None:
    def pos(i: int, verbatim: bool = True, hedged: bool = False) -> dict:
        return {"position": f"p{i}", "verbatim": verbatim, "hedged": hedged}

    found = {
        "t1": [pos(1), pos(2, verbatim=False), pos(3), pos(4, hedged=True), pos(5), pos(6)],
        "t2": [pos(7), pos(8), pos(9), pos(10), pos(11), pos(12)],
    }
    assert trim_positions(found, cap=20) == found  # under the cap nothing moves
    trimmed = trim_positions(found, cap=8)
    assert [p["position"] for p in trimmed["t1"]] == [
        "p1",
        "p3",
        "p5",
        "p6",
    ]  # firm first, in order
    assert [p["position"] for p in trimmed["t2"]] == ["p7", "p8", "p9", "p10"]
