from __future__ import annotations

import asyncio
from typing import Any, Callable

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


def test_trim_is_an_exact_cap_that_uses_every_slot() -> None:
    def pos(i: int) -> dict:
        return {"position": f"p{i}", "verbatim": True, "hedged": False}

    # Twenty-five transcripts of five: the cap holds exactly, every transcript keeps some.
    many = {f"t{n}": [pos(n * 10 + i) for i in range(5)] for n in range(25)}
    trimmed = trim_positions(many, cap=80)
    assert sum(len(v) for v in trimmed.values()) == 80
    assert all(len(v) >= 3 for v in trimmed.values())
    # Uneven tables: the small one keeps its one, the rest fill the cap exactly.
    uneven = {
        "a": [pos(1)],
        "b": [pos(i) for i in range(10, 40)],
        "c": [pos(i) for i in range(50, 80)],
    }
    trimmed = trim_positions(uneven, cap=41)
    assert len(trimmed["a"]) == 1 and len(trimmed["b"]) + len(trimmed["c"]) == 40


def test_a_facets_quotes_stay_with_their_pole_and_the_registry_names_the_right_table() -> None:
    T3 = "Do not rush this, it needs checking. Move quickly or we lose the moment."
    transcripts = {"zz": T1, "aa": T2, "mm": T3}
    log: list[str] = []
    writes = {"n": 0}

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            return {"handed": []}
        if schema is POSITIONS_SCHEMA:
            tid = user_text.split("TRANSCRIPT id: ", 1)[1].split("\n", 1)[0].strip()
            if tid == "zz":
                return {
                    "positions": [
                        {
                            "position": "record everything",
                            "holder": "h",
                            "kind": "want",
                            "hedged": False,
                            "quote": "record everything so nothing is lost",
                        }
                    ]
                }
            if tid == "aa":
                return {
                    "positions": [
                        {
                            "position": "no permanent record",
                            "holder": "h",
                            "kind": "constraint",
                            "hedged": False,
                            "quote": "would not speak freely on a permanent record",
                        }
                    ]
                }
            return {
                "positions": [
                    {
                        "position": "check carefully",
                        "holder": "h",
                        "kind": "value",
                        "hedged": False,
                        "quote": "Do not rush this",
                    }
                ]
            }
        if schema is COLLISIONS_SCHEMA:
            focal = user_text.rsplit("FOCAL POSITION: ", 1)[1].strip()
            log.append(f"collisions:{focal}")
            return (
                {
                    "collides": [
                        {"id": "P2", "why": "candour", "zero_sum": 0.9},
                        {"id": "P3", "why": "haste", "zero_sum": 0.8},
                    ]
                }
                if focal == "P1"
                else {"collides": []}
            )
        if schema is VERIFY_SCHEMA:
            if "check carefully" in user_text:
                return {
                    "valid": True,
                    "why": "held",
                    "poleA": "record every conversation",
                    "poleB": "check it carefully first",
                    "quotesA": ["record everything so nothing is lost"],
                    "quotesB": ["Do not rush this"],
                }
            return {
                "valid": True,
                "why": "held",
                "poleA": "record every conversation",
                "poleB": "no permanent record",
                "quotesA": ["record everything so nothing is lost"],
                "quotesB": ["would not speak freely on a permanent record"],
            }
        if schema is DEDUPE_SCHEMA:
            log.append("dedupe")
            return {"same_as": "x1", "why": "a facet"}
        if schema is WRITE_SCHEMA:
            writes["n"] += 1
            assert "FACETS OF THE SAME PULL" in user_text
            # The facet's quote arrived under HOLDING B, never under HOLDING A.
            assert "Do not rush this" in user_text.split("HOLDING B:", 1)[1].split("\n", 1)[0]
            assert "Do not rush this" not in user_text.split("HOLDING A:", 1)[1].split("\n", 1)[0]
            return {
                "poleA": "",
                "poleB": "",
                "knot": "Record it all and candour goes; keep it off the record and the memory goes.",
                "toResolve": "Which conversations go on the record, and who decides?",
            }
        raise AssertionError("unexpected schema")

    book = QuoteBook(transcripts)
    result = asyncio.run(
        run_pipeline(
            transcripts, book, generate=generate, prompts=PROMPTS, concurrency=3, max_tensions=1
        )
    )
    tensions = result["tensions"]["tensions"]
    assert len(tensions) == 1 and writes["n"] == 1
    # Both pairs were deduped into x1 even though the cap of one was already reached.
    assert log.count("dedupe") == 1
    # Quotes were registered against the pole's own transcript, not the sorted first and last.
    by_id = {q["id"]: q for q in book.quotes}
    regs = [by_id[q]["transcript"] for q in tensions[0]["quoteIds"]]
    assert regs == ["zz", "aa", "mm"]


def test_a_failed_stage_cancels_its_siblings() -> None:
    cancelled: list[str] = []

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            return {"handed": []}
        if schema is POSITIONS_SCHEMA:
            if "id: t1" in user_text:
                raise RuntimeError("quota")
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled.append("t2")
                raise
            return {"positions": []}
        raise AssertionError("unexpected schema")

    book = QuoteBook({"t1": T1, "t2": T2})

    async def run() -> None:
        try:
            await run_pipeline(
                {"t1": T1, "t2": T2}, book, generate=generate, prompts=PROMPTS, concurrency=2
            )
        except* RuntimeError:
            pass

    asyncio.run(run())
    assert cancelled == ["t2"]


def test_the_best_pair_of_every_table_is_verified() -> None:
    from dembrane.popcorn import tensions as mod

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            return {"handed": []}
        if schema is POSITIONS_SCHEMA:
            tid = user_text.split("TRANSCRIPT id: ", 1)[1].split("\n", 1)[0].strip()
            n = 3 if tid in ("ta", "tb") else 1
            return {
                "positions": [
                    {
                        "position": f"{tid} wants {i}",
                        "holder": "h",
                        "kind": "want",
                        "hedged": False,
                        "quote": "x",
                    }
                    for i in range(n)
                ]
            }
        if schema is COLLISIONS_SCHEMA:
            focal = user_text.rsplit("FOCAL POSITION: ", 1)[1].strip()
            listing = user_text.split("ALL POSITIONS:", 1)[1].split("FOCAL POSITION:", 1)[0]
            ids = [line.split(" ", 1)[0] for line in listing.strip().splitlines()]
            table_of = {
                line.split(" ", 1)[0]: line.split("[", 1)[1].split(" ", 1)[0]
                for line in listing.strip().splitlines()
            }
            mine = table_of[focal]
            # ta and tb collide hard with each other; tc's single position collides mildly with everything.
            out = []
            for other in ids:
                if other == focal:
                    continue
                if {mine, table_of[other]} == {"T1", "T2"}:
                    out.append({"id": other, "why": "loud", "zero_sum": 0.95})
                elif "T3" in (mine, table_of[other]):
                    out.append({"id": other, "why": "quiet", "zero_sum": 0.3})
            return {"collides": out}
        if schema is VERIFY_SCHEMA:
            return {
                "valid": False,
                "why": "n",
                "poleA": "",
                "poleB": "",
                "quotesA": [],
                "quotesB": [],
            }
        raise AssertionError("unexpected schema")

    old = mod.MAX_CANDIDATES
    mod.MAX_CANDIDATES = 4
    try:
        book = QuoteBook({"ta": "a", "tb": "b", "tc": "c"})
        result = asyncio.run(
            run_pipeline(
                {"ta": "a", "tb": "b", "tc": "c"},
                book,
                generate=generate,
                prompts=PROMPTS,
                concurrency=3,
            )
        )
    finally:
        mod.MAX_CANDIDATES = old
    # Nine loud ta/tb pairs exist; the cap of four still verified one of tc's quiet pairs.
    assert result["counts"]["found_pairs"] > 4
    assert result["counts"]["candidates"] == 4


def _stub(
    *,
    verify: dict[str, Any] | Callable[[str], dict[str, Any]],
    dedupe: dict[str, Any] | None = None,
    positions: dict[str, list[dict[str, Any]]] | None = None,
    collide: dict[str, list[dict[str, Any]]] | None = None,
    handed: list[dict[str, Any]] | None = None,
    seen: list[str] | None = None,
):
    """A generate stub built from answers per stage. `verify` may be a dict or
    a function of the verify call's user text; `collide` maps a focal id to
    its collisions; `positions` maps a transcript id to its positions."""
    seen = seen if seen is not None else []

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            return {"handed": handed or []}
        if schema is POSITIONS_SCHEMA:
            tid = user_text.split("TRANSCRIPT id: ", 1)[1].split("\n", 1)[0].strip()
            return {"positions": (positions or {}).get(tid, [])}
        if schema is COLLISIONS_SCHEMA:
            focal = user_text.rsplit("FOCAL POSITION: ", 1)[1].strip()
            return {"collides": (collide or {}).get(focal, [])}
        if schema is VERIFY_SCHEMA:
            seen.append(user_text)
            return verify(user_text) if callable(verify) else verify
        if schema is DEDUPE_SCHEMA:
            return dedupe or {"same_as": "", "swapped": False, "why": ""}
        if schema is WRITE_SCHEMA:
            return {
                "poleA": "",
                "poleB": "",
                "knot": "Record it and candour goes; keep it off and the memory goes.",
                "toResolve": "Which conversations go on the record?",
            }
        raise AssertionError("unexpected schema")

    return generate


def _pos(position: str, quote: str, kind: str = "want") -> dict[str, Any]:
    return {"position": position, "holder": "h", "kind": kind, "hedged": False, "quote": quote}


def test_a_tension_needs_evidence_on_both_poles() -> None:
    """Astra's reproduction (September 5th 2026): a pair the verifier calls
    valid with two pole labels and no quotes reached the deck as a tension
    with `quoteIds: []`. Now it is unsupported and dropped."""
    generate = _stub(
        verify={
            "valid": True,
            "why": "both held",
            "poleA": "record every conversation",
            "poleB": "keep no recording",
            "quotesA": [],
            "quotesB": ["would not speak freely on a permanent record"],
        },
        positions={
            "t1": [_pos("record everything", "record everything")],
            "t2": [_pos("no record", "permanent record")],
        },
        collide={"P1": [{"id": "P2", "why": "candour", "zero_sum": 0.9}]},
    )
    book = QuoteBook({"t1": T1, "t2": T2})
    result = asyncio.run(
        run_pipeline({"t1": T1, "t2": T2}, book, generate=generate, prompts=PROMPTS)
    )
    assert result["tensions"] == {"tensions": []}
    assert result["counts"]["verified"] == 0 and result["counts"]["unsupported"] == 1
    assert book.quotes == []


def test_a_quote_is_registered_against_the_transcript_that_holds_it() -> None:
    """The verifier may quote pole A with words said at pole B's table; the
    quote goes into the registry under the table that said them, and when both
    tables said them, under the pole's own."""
    both = "Some things stay in the room."
    t1 = T1 + " " + both
    generate = _stub(
        verify={
            "valid": True,
            "why": "both held",
            "poleA": "record every conversation",
            "poleB": "no permanent record",
            # said only at t2, quoted for pole A; said at both, quoted for pole B
            "quotesA": ["would not speak freely on a permanent record", both],
            "quotesB": [both],
        },
        positions={
            "t1": [_pos("record everything", "record everything")],
            "t2": [_pos("no record", "permanent record")],
        },
        collide={"P1": [{"id": "P2", "why": "candour", "zero_sum": 0.9}]},
    )
    book = QuoteBook({"t1": t1, "t2": T2})
    result = asyncio.run(
        run_pipeline({"t1": t1, "t2": T2}, book, generate=generate, prompts=PROMPTS)
    )
    t = result["tensions"]["tensions"][0]
    by_id = {q["id"]: q for q in book.quotes}
    regs = [(by_id[q]["transcript"], by_id[q]["text"]) for q in t["quoteIds"]]
    assert regs == [
        ("t2", "would not speak freely on a permanent record"),
        ("t1", both),  # pole A's own table first
        ("t2", both),  # pole B's own table
    ]


def test_a_swapped_facet_puts_its_quotes_on_the_other_pole() -> None:
    T3 = "Do not rush this, it needs checking. Move quickly or we lose the moment."
    transcripts = {"t1": T1, "t2": T2, "t3": T3}
    writes: list[str] = []

    def verify(user_text: str) -> dict[str, Any]:
        if "check carefully" in user_text:
            # The facet arrives the other way round: its A is the kept tension's B side.
            return {
                "valid": True,
                "why": "held",
                "poleA": "check it carefully first",
                "poleB": "record every conversation",
                "quotesA": ["Do not rush this"],
                "quotesB": ["record everything so nothing is lost"],
            }
        return {
            "valid": True,
            "why": "held",
            "poleA": "record every conversation",
            "poleB": "no permanent record",
            "quotesA": ["record everything so nothing is lost"],
            "quotesB": ["would not speak freely on a permanent record"],
        }

    generate = _stub(
        verify=verify,
        dedupe={"same_as": "x1", "swapped": True, "why": "a facet, poles the other way"},
        positions={
            "t1": [_pos("record everything", "record everything so nothing is lost")],
            "t2": [
                _pos(
                    "no permanent record",
                    "would not speak freely on a permanent record",
                    "constraint",
                )
            ],
            "t3": [_pos("check carefully", "Do not rush this", "value")],
        },
        collide={
            "P1": [
                {"id": "P2", "why": "candour", "zero_sum": 0.9},
                {"id": "P3", "why": "haste", "zero_sum": 0.8},
            ]
        },
    )

    async def spy(**kwargs: Any) -> dict[str, Any]:
        if kwargs["schema"] is WRITE_SCHEMA:
            writes.append(kwargs["user_text"])
        return await generate(**kwargs)

    book = QuoteBook(transcripts)
    result = asyncio.run(
        run_pipeline(transcripts, book, generate=spy, prompts=PROMPTS, max_tensions=1)
    )
    assert len(result["tensions"]["tensions"]) == 1 and len(writes) == 1
    holding_a = writes[0].split("HOLDING A:", 1)[1].split("\n", 1)[0]
    holding_b = writes[0].split("HOLDING B:", 1)[1].split("\n", 1)[0]
    # The facet's "Do not rush this" held its pole A, which is the kept pole B.
    assert "Do not rush this" in holding_b and "Do not rush this" not in holding_a
    by_id = {q["id"]: q for q in book.quotes}
    assert [by_id[q]["transcript"] for q in result["tensions"]["tensions"][0]["quoteIds"]] == [
        "t1",
        "t2",
        "t3",
    ]


def test_handed_items_whose_quote_is_not_in_the_transcripts_are_marked() -> None:
    seen: list[str] = []
    generate = _stub(
        verify={"valid": False, "why": "n", "poleA": "", "poleB": "", "quotesA": [], "quotesB": []},
        positions={"t1": [_pos("a", "x")], "t2": [_pos("b", "y")]},
        collide={"P1": [{"id": "P2", "why": "w", "zero_sum": 0.5}]},
        handed=[
            {
                "text": "capture vs privacy",
                "quote": "record everything so nothing is lost",
                "transcript": "t1",
                "response": "argued",
                "status": "argued",
            },
            {
                "text": "a card nobody read",
                "quote": "these words were never said",
                "transcript": "t2",
                "response": "ignored",
                "status": "ignored",
            },
        ],
        seen=seen,
    )
    book = QuoteBook({"t1": T1, "t2": T2})
    result = asyncio.run(
        run_pipeline({"t1": T1, "t2": T2}, book, generate=generate, prompts=PROMPTS)
    )
    assert len(seen) == 1
    handed = seen[0].split("WHAT THE ROOMS WERE HANDED:", 1)[1].split("THE PAIR:", 1)[0]
    first, second = handed.split("- [argued]", 1)[1].split("- [ignored]", 1)
    assert "not found" not in first and "its quote was not found in the transcripts" in second
    assert result["counts"]["handed"] == 2 and result["counts"]["handed_verified"] == 1


def test_handed_and_positions_run_side_by_side() -> None:
    positions_started = asyncio.Event()

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is HANDED_SCHEMA:
            # Sequential stages would wait here forever: positions never start.
            await asyncio.wait_for(positions_started.wait(), 2)
            return {"handed": []}
        if schema is POSITIONS_SCHEMA:
            positions_started.set()
            return {"positions": []}
        raise AssertionError("unexpected schema")

    async def run() -> dict[str, Any]:
        book = QuoteBook({"t1": T1})
        return await asyncio.wait_for(
            run_pipeline({"t1": T1}, book, generate=generate, prompts=PROMPTS), 5
        )

    assert asyncio.run(run())["tensions"] == {"tensions": []}


def test_trim_keeps_one_position_for_every_transcript() -> None:
    """Astra's reproduction: 81 transcripts with one position each and a cap
    of 80 left one transcript with no position at all. A table is never
    squeezed off the slide by the budget."""
    many = {f"t{i}": [{"position": str(i), "verbatim": True, "hedged": False}] for i in range(81)}
    trimmed = trim_positions(many, cap=80)
    assert all(len(items) == 1 for items in trimmed.values())
    # With room to spare the cap still holds exactly.
    two_each = {
        f"t{i}": [
            {"position": f"{i}a", "verbatim": True, "hedged": False},
            {"position": f"{i}b", "verbatim": True, "hedged": False},
        ]
        for i in range(50)
    }
    trimmed = trim_positions(two_each, cap=80)
    assert sum(len(v) for v in trimmed.values()) == 80 and all(v for v in trimmed.values())
