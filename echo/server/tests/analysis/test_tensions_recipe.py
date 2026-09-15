from __future__ import annotations

import asyncio
from typing import Any, Callable

import pytest

from dembrane.popcorn import tensions as stages
from dembrane.analysis.recipes.tensions import (
    NOT_ASSESSED,
    PROMPT_NAMES,
    Evidence,
    SourcePassages,
    ArgumentRevision,
    run_tensions,
    default_prompts,
    prompt_versions,
    positions_from_arguments,
)

T1 = "We should record everything so nothing is lost. The notes never capture it."
T2 = "I would not speak freely on a permanent record. Some things stay in the room."
T3 = "Do not rush this, it needs checking. Move quickly or we lose the moment."
SOURCES = [
    SourcePassages("c1", "Table 1", transcript=T1),
    SourcePassages("c2", "Table 2", transcript=T2),
    SourcePassages("c3", "Table 3", transcript=T3),
]
PROMPTS = {n: f"[{n}]" for n in PROMPT_NAMES}


def _arg(
    rev: str,
    statement: str,
    evidence: tuple[tuple[str, str], ...] | list[tuple[str, str]] = (),
    *,
    kind: str = "argument",
    type_: str = "argument",
    members: tuple[str, ...] = (),
) -> ArgumentRevision:
    return ArgumentRevision(
        revision_id=rev,
        object_id=f"o-{rev}",
        type=type_,  # type: ignore[arg-type]
        statement=statement,
        epistemic_kind=kind,  # type: ignore[arg-type]
        valence="neutral",
        evidence=tuple(Evidence(cid, quote) for cid, quote in evidence),
        member_revision_ids=members,
    )


RECORD = _arg("r1", "record every conversation", [("c1", "record everything so nothing is lost")])
NO_RECORD = _arg(
    "r2", "no permanent record", [("c2", "would not speak freely on a permanent record")]
)
CAREFUL = _arg("r3", "check it carefully first", [("c3", "Do not rush this")])


def _stub(
    *,
    collide: dict[str, list[tuple[str, float]]] | None = None,
    verify: dict[str, Any] | Callable[[str], dict[str, Any]] | None = None,
    dedupe: dict[str, Any] | None = None,
    calls: list[tuple[str, str, str]] | None = None,
):
    """A generate stub answering per stage, recording (stage, system, user)."""
    log = calls if calls is not None else []

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool
    ) -> dict[str, Any]:
        if schema is stages.HANDED_SCHEMA:
            log.append(("handed", system_prompt, user_text))
            return {"handed": []}
        if schema is stages.COLLISIONS_SCHEMA:
            log.append(("collisions", system_prompt, user_text))
            focal = user_text.rsplit("FOCAL POSITION: ", 1)[1].strip()
            return {
                "collides": [
                    {"id": other, "why": "one pays", "zero_sum": score}
                    for other, score in (collide or {}).get(focal, [])
                ]
            }
        if schema is stages.VERIFY_SCHEMA:
            log.append(("verify", system_prompt, user_text))
            if callable(verify):
                return verify(user_text)
            return verify or {
                "valid": True,
                "why": "both held",
                "poleA": "record every conversation",
                "poleB": "no permanent record",
                # The verifier's own quotes never reach a pole.
                "quotesA": ["an invented line nobody said"],
                "quotesB": [],
            }
        if schema is stages.DEDUPE_SCHEMA:
            log.append(("dedupe", system_prompt, user_text))
            return dedupe or {"same_as": "", "swapped": False, "why": ""}
        if schema is stages.WRITE_SCHEMA:
            log.append(("write", system_prompt, user_text))
            return {
                "poleA": "",
                "poleB": "",
                "knot": "Record it and candour goes; keep it off and the memory goes.",
                "toResolve": "Which conversations go on the record?",
            }
        raise AssertionError("no position extraction or other call is expected")

    return generate


def _run(arguments: list[ArgumentRevision], generate: Any, **kw: Any):
    kw.setdefault("sources", SOURCES)
    kw.setdefault("prompts", PROMPTS)
    return asyncio.run(run_tensions(arguments, generate=generate, **kw))


def test_arguments_become_positions_without_an_extraction_call() -> None:
    hedged = _arg(
        "r4", "maybe a summary is enough", [("c3", "Move quickly or we lose the moment")]
    )
    claim = _arg("r5", "notes never capture it", [("c1", "The notes never capture it")], kind="claim")
    positions, coverage = positions_from_arguments([RECORD, hedged, claim], SOURCES)
    by_rev = {p["revision_id"]: p for p in positions}
    assert by_rev["r1"]["holder"] == "a speaker in Table 1" and by_rev["r1"]["transcript"] == "c1"
    assert by_rev["r1"]["evidence"][0]["text"] == "record everything so nothing is lost"
    assert by_rev["r4"]["hedged"] is True and by_rev["r1"]["hedged"] is False
    assert by_rev["r5"]["kind"] == "claim" and all(p["verbatim"] for p in positions)
    assert coverage.conversations_with_evidence == 2 and coverage.positions == 0

    calls: list[tuple[str, str, str]] = []
    result = _run([RECORD, NO_RECORD, claim], _stub(calls=calls))
    assert {stage for stage, _, _ in calls} <= {"handed", "collisions"}
    listing = next(user for stage, _, user in calls if stage == "collisions")
    # Positions are numbered by conversation: the claim at Table 1 follows r1.
    assert "P2 [T1 · a speaker in Table 1 · claim] notes never capture it" in listing
    assert "P3 [T2 · a speaker in Table 2 · argument] no permanent record" in listing
    assert result.status == "ok" and result.input_set == "raw"
    assert result.input_revision_ids == ["r1", "r2", "r5"]


def test_both_poles_carry_argument_revisions_with_verified_quotes() -> None:
    calls: list[tuple[str, str, str]] = []
    result = _run([RECORD, NO_RECORD], _stub(collide={"P1": [("P2", 0.9)]}, calls=calls))
    assert [c[0] for c in calls].count("verify") == 1
    (tension,) = result.tensions
    assert [s.revision_id for s in tension.supporters_a] == ["r1"]
    assert [s.revision_id for s in tension.supporters_b] == ["r2"]
    # Quotes come from the arguments' evidence, not from the verifier.
    texts = [(q.conversation_id, q.text) for q in tension.quotes]
    assert texts == [
        ("c1", "record everything so nothing is lost"),
        ("c2", "would not speak freely on a permanent record"),
    ]
    assert tension.quote_ids == ["q1", "q2"]
    assert tension.supporters_a[0].quote_ids == ["q1"]
    assert [(r.type, r.from_revision_id, r.to_tension, r.basis) for r in result.relations] == [
        ("supports_pole_a", "r1", "x1", "extracted"),
        ("supports_pole_b", "r2", "x1", "extracted"),
    ]
    check = result.relations[0].check
    assert check["step"] == "verify" and check["via"] == "pair" and check["pair"] == ["r1", "r2"]
    assert set(tension.payload()) == {"poleA", "poleB", "knot", "toResolve", "quoteIds", "quotes"}
    assert tension.payload()["poleA"] == "record every conversation"
    assert result.counts["candidates"] == 1 and result.counts["unsupported"] == 0
    assert result.coverage.framing == "assessed" and result.suggestion is None
    assert result.as_dict()["relations"][1]["type"] == "supports_pole_b"


@pytest.mark.parametrize("swapped", [False, True])
def test_a_facet_adds_its_arguments_to_the_right_pole(swapped: bool) -> None:
    # Unswapped: the facet (r1, r3) sides like the kept (r1, r2), so r3 joins pole B.
    # Swapped: the facet (r2, r3) arrives the other way round, so r3 joins pole A.
    collide = (
        {"P1": [("P2", 0.9)], "P2": [("P3", 0.8)]}
        if swapped
        else {"P1": [("P2", 0.9), ("P3", 0.8)]}
    )
    calls: list[tuple[str, str, str]] = []
    result = _run(
        [RECORD, NO_RECORD, CAREFUL],
        _stub(
            collide=collide,
            dedupe={"same_as": "x1", "swapped": swapped, "why": "a facet"},
            calls=calls,
        ),
        max_tensions=1,
    )
    (tension,) = result.tensions
    pole_a = [s.revision_id for s in tension.supporters_a]
    pole_b = [s.revision_id for s in tension.supporters_b]
    if swapped:
        assert pole_a == ["r1", "r3"] and pole_b == ["r2"]
    else:
        assert pole_a == ["r1"] and pole_b == ["r2", "r3"]
    (write,) = [user for stage, _, user in calls if stage == "write"]
    holding_a = write.split("HOLDING A:", 1)[1].split("\n", 1)[0]
    holding_b = write.split("HOLDING B:", 1)[1].split("\n", 1)[0]
    assert ("Do not rush this" in holding_a) is swapped
    assert ("Do not rush this" in holding_b) is not swapped
    facet = next(r for r in result.relations if r.from_revision_id == "r3")
    assert facet.type == ("supports_pole_a" if swapped else "supports_pole_b")
    assert facet.check["via"] == "facet" and facet.check["dedupe"]["swapped"] is swapped
    assert result.counts["merged"] == 1 and len(result.relations) == 3
    assert result.counts["both_poles_skipped"] == 0 and result.coverage.both_poles_skipped == []


def test_an_argument_whose_evidence_is_not_found_leaves_the_collision_stage() -> None:
    unheard = _arg("r2", "no permanent record", [("c2", "these words were never said")])
    calls: list[tuple[str, str, str]] = []
    # The collider names P3, the slot the unheard argument would have taken: no such position.
    result = _run(
        [RECORD, unheard, CAREFUL], _stub(collide={"P1": [("P3", 0.9)]}, calls=calls)
    )
    collisions = [user for stage, _, user in calls if stage == "collisions"]
    assert len(collisions) == 2
    assert all("no permanent record" not in user for user in collisions)
    assert "verify" not in [c[0] for c in calls]
    assert result.usage["calls_by_stage"] == {"handed": 1, "collisions": 2}
    assert result.status == "ok" and result.tensions == [] and result.relations == []
    assert result.counts["candidates"] == 0 and result.coverage.positions == 2
    assert result.coverage.evidence_not_found == ["r2"]
    assert result.suggestion == "refresh_arguments"


def test_a_facet_that_would_put_an_argument_on_both_poles_is_counted() -> None:
    # The facet (r1, r3) arrives swapped: r1 would move to pole B while it holds pole A.
    result = _run(
        [RECORD, NO_RECORD, CAREFUL],
        _stub(
            collide={"P1": [("P2", 0.9), ("P3", 0.8)]},
            dedupe={"same_as": "x1", "swapped": True, "why": "a facet the other way"},
        ),
        max_tensions=1,
    )
    (tension,) = result.tensions
    assert [s.revision_id for s in tension.supporters_a] == ["r1", "r3"]
    assert [s.revision_id for s in tension.supporters_b] == ["r2"]
    assert result.counts["both_poles_skipped"] == 1
    assert result.coverage.both_poles_skipped == ["r1"]
    assert [r.from_revision_id for r in result.relations].count("r1") == 1


def test_deduplicated_arguments_carry_their_members_for_evidence() -> None:
    m1 = _arg("m1", "record it all", [("c1", "record everything so nothing is lost")])
    m3 = _arg("m3", "move quickly", [("c3", "Move quickly or we lose the moment")])
    d1 = _arg("d1", "record every conversation", type_="deduplicated_argument", members=("m1", "m3"))
    d2 = _arg(
        "d2",
        "no permanent record",
        [("c2", "would not speak freely on a permanent record")],
        type_="deduplicated_argument",
    )
    d3 = _arg("d3", "an orphan", type_="deduplicated_argument", members=("gone",))
    calls: list[tuple[str, str, str]] = []
    result = _run(
        [d1, d2, d3], _stub(collide={"P1": [("P2", 0.9)]}, calls=calls), members=[m1, m3]
    )
    assert result.input_set == "deduplicated" and result.input_revision_ids == ["d1", "d2", "d3"]
    (tension,) = result.tensions
    (supporter,) = tension.supporters_a
    assert supporter.revision_id == "d1" and supporter.member_revision_ids == ["m1", "m3"]
    by_id = {q.id: q for q in result.quotes}
    assert [by_id[q].conversation_id for q in supporter.quote_ids] == ["c1", "c3"]
    (verify,) = [user for stage, _, user in calls if stage == "verify"]
    assert "speakers in Table 1 and Table 3" in verify
    assert all(f"TRANSCRIPT id: {c}" in verify for c in ("c1", "c2", "c3"))
    assert result.coverage.without_evidence == ["d3"]
    assert result.coverage.members_missing == {"d3": ["gone"]}


def test_zero_tensions_is_a_valid_result_and_trimming_is_reported() -> None:
    extra = _arg("r4", "notes never capture it", [("c1", "The notes never capture it")])
    result = _run([RECORD, extra, NO_RECORD], _stub(), max_positions=2)
    assert result.status == "ok" and result.tensions == [] and result.relations == []
    assert result.counts["candidates"] == 0 and result.usage["calls_by_stage"] == {
        "handed": 1,
        "collisions": 2,
    }
    # One position per conversation survives the cap; the second at Table 1 is reported.
    assert result.coverage.trimmed == ["r4"] and result.coverage.positions == 2


def test_thin_coverage_reports_and_suggests_a_refresh_without_calls() -> None:
    elsewhere = _arg("r9", "a view from a missing table", [("c9", "anything at all")])
    notes = _arg("r4", "notes never capture it", [("c1", "The notes never capture it")])

    async def never(**_: Any) -> dict[str, Any]:
        raise AssertionError("thin coverage makes no call")

    result = _run([RECORD, notes, elsewhere], never)
    assert result.status == "insufficient_coverage" and result.coverage.thin
    assert result.suggestion == "refresh_arguments" and result.usage["calls"] == 0
    assert result.coverage.without_source == ["r9"]
    assert result.coverage.conversations_with_evidence == 1
    assert "at least 2" in (result.coverage.note or "")


def test_the_host_note_does_not_leak_into_verification() -> None:
    note = "NOTE-7F3 keep the language gentle"
    calls: list[tuple[str, str, str]] = []
    result = _run(
        [RECORD, NO_RECORD, CAREFUL],
        _stub(collide={"P1": [("P2", 0.9), ("P3", 0.8)]}, calls=calls),
        host_note=note,
    )
    assert result.tensions
    for stage, system, user in calls:
        if stage == "write":
            assert note in user
        else:
            assert note not in system and note not in user, stage
    assert {c[0] for c in calls} >= {"handed", "collisions", "verify", "dedupe", "write"}


def test_passage_windows_skip_the_framing_stage() -> None:
    windows = [
        SourcePassages("c1", "Table 1", passages=["record everything so nothing is lost"]),
        SourcePassages("c2", "Table 2", passages=["I would not speak freely on a permanent record"]),
    ]
    calls: list[tuple[str, str, str]] = []
    result = _run(
        [RECORD, NO_RECORD], _stub(collide={"P1": [("P2", 0.9)]}, calls=calls), sources=windows
    )
    assert "handed" not in [c[0] for c in calls]
    (verify,) = [user for stage, _, user in calls if stage == "verify"]
    assert NOT_ASSESSED in verify
    assert result.coverage.framing == "not_assessed" and len(result.tensions) == 1


def test_mixed_or_repeated_argument_sets_fail_before_any_call() -> None:
    dedup = _arg("d1", "x", [("c1", "record everything")], type_="deduplicated_argument")

    async def never(**_: Any) -> dict[str, Any]:
        raise AssertionError("invalid input makes no call")

    with pytest.raises(ValueError, match="raw or deduplicated"):
        _run([RECORD, dedup], never)
    with pytest.raises(ValueError, match="pinned twice"):
        _run([RECORD, RECORD], never)


def test_prompt_versions_name_the_popcorn_prompts_in_use() -> None:
    versions = prompt_versions(default_prompts())
    assert versions["collisions"].startswith("collisions-v")
    assert versions["tension-verify"].startswith("tension-verify-v")
    assert versions["tension-dedupe"].startswith("sha256:")
