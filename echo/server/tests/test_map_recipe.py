"""Map's recipe, the pure half: grounding, windows, consolidation, manifest, titles."""

from __future__ import annotations

import math
from typing import Any

import pytest

from dembrane.map import recipe
from dembrane.map.recipe import (
    Transcript,
    InvalidVector,
    SelectionTooLarge,
    SelectionTooSmall,
    norm_key,
    claim_key,
    input_hash,
    consolidate,
    title_lines,
    ground_quote,
    build_manifest,
    representative,
    validate_vector,
    shape_extraction,
    source_fingerprint,
    transcript_windows,
    title_selection_key,
    merge_conversation_candidates,
)

LIBRARY = (
    "Speaker 1: The council should fund the new library before anything else,\n"
    "because the old one is   falling apart and the children have nowhere to read."
)


def _key(text: str) -> str:
    return norm_key(text)


# ── grounding ───────────────────────────────────────────────────────────


def test_ground_quote_accepts_verbatim_case_and_whitespace_insensitively() -> None:
    key = _key(LIBRARY)
    assert ground_quote("the council should fund the new library", key) == (
        "the council should fund the new library"
    )
    assert ground_quote("THE  council\nshould FUND the new library", key) == (
        "THE council should FUND the new library"
    )
    assert ground_quote("“the old one is falling apart”", key) == "the old one is falling apart"


def test_ground_quote_rejects_paraphrases_and_empty_quotes() -> None:
    key = _key(LIBRARY)
    assert ground_quote("the council must pay for a new library first", key) is None
    assert ground_quote("   ", key) is None
    assert ground_quote('""', key) is None


@pytest.mark.parametrize("marker", ["...", "…"])
def test_ground_quote_accepts_ordered_ellipsis_fragments(marker: str) -> None:
    key = _key(LIBRARY)
    quote = f"The council should fund the new library {marker} the children have nowhere to read"
    assert ground_quote(quote, key) == quote


def test_ground_quote_rejects_short_or_out_of_order_fragments() -> None:
    key = _key(LIBRARY)
    # "the council" is eleven characters: below the twelve-character floor.
    assert ground_quote("the council ... the children have nowhere to read", key) is None
    assert ground_quote("the old one is falling apart ... to read", key) is None
    # Every fragment is present and long enough, but in the wrong order.
    assert (
        ground_quote("the children have nowhere to read ... the council should fund", key)
        is None
    )


# ── shaping an extraction ───────────────────────────────────────────────


def test_shape_extraction_keeps_grounded_items_and_counts_drops() -> None:
    transcript = Transcript(id="c1", label="Ann", created_at=None, text=LIBRARY)
    raw = {
        "items": [
            {
                "kind": "argument",
                "statement": "  The council should   fund the new library first. ",
                "valence": "positive",
                "evidence": [
                    "the council should fund the new library",
                    "THE COUNCIL SHOULD FUND THE NEW LIBRARY",  # duplicate after casefold
                    "a quote that was never said at all",
                    "the old one is falling apart",
                ],
            },
            {
                "kind": "argument",
                "statement": "Libraries are good.",
                "valence": "positive",
                "evidence": ["libraries are wonderful places"],  # paraphrase only
            },
            {
                "kind": "opinion",
                "statement": "x",
                "valence": "positive",
                "evidence": ["the old one"],
            },
            {
                "kind": "claim",
                "statement": "y",
                "valence": "mixed",
                "evidence": ["the old one is falling apart"],
            },
            {"kind": "claim", "statement": "", "valence": "neutral", "evidence": ["the old one"]},
            "not an object",
        ]
    }

    candidates, dropped = shape_extraction(raw, transcript, window_index=2)

    assert dropped == 5
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate["statement"] == "The council should fund the new library first."
    assert candidate["quotes"] == [
        "the council should fund the new library",
        "the old one is falling apart",
    ]
    assert candidate["conversation_id"] == "c1"
    assert candidate["order"] == [2, 0]
    assert candidate["id"] == recipe.candidate_id("c1", candidate["statement"], "argument")


def test_shape_extraction_caps_quotes_and_tolerates_non_dict_answers() -> None:
    lines = [f"line number {i:02d} says something distinct" for i in range(10)]
    transcript = Transcript(id="c1", label="", created_at=None, text="\n".join(lines))
    raw = {
        "items": [
            {"kind": "claim", "statement": "s", "valence": "neutral", "evidence": lines}
        ]
    }
    candidates, dropped = shape_extraction(raw, transcript)
    assert dropped == 0
    assert len(candidates[0]["quotes"]) == recipe.MAX_QUOTES_PER_ITEM

    assert shape_extraction(["items"], transcript) == ([], 0)
    assert shape_extraction({"items": "nope"}, transcript) == ([], 0)


def test_merge_conversation_candidates_unions_quotes_but_keeps_valences_apart() -> None:
    first = {
        "id": "c-1",
        "conversation_id": "c1",
        "statement": "S",
        "kind": "argument",
        "valence": "positive",
        "quotes": ["alpha quote"],
        "order": [0, 0],
    }
    same_later = {**first, "quotes": ["Alpha quote", "beta quote"], "order": [1, 3]}
    opposite = {**first, "valence": "negative", "quotes": ["gamma quote"], "order": [1, 4]}

    merged = merge_conversation_candidates([[first], [same_later, opposite]])

    assert [c["id"] for c in merged] == ["c-1", "c-1-n"]
    assert merged[0]["quotes"] == ["alpha quote", "beta quote"]
    assert merged[1]["valence"] == "negative"
    assert first["quotes"] == ["alpha quote"]  # inputs are not mutated


# ── windows and fingerprints ────────────────────────────────────────────


def test_short_and_empty_texts_are_one_or_no_window() -> None:
    assert transcript_windows("  hello  ", limit=100) == ["hello"]
    assert transcript_windows("   ", limit=100) == []


def test_windows_respect_the_limit_and_overlap() -> None:
    lines = [f"{i:03d} " + "x" * 26 for i in range(40)]  # 30 characters each
    windows = transcript_windows("\n".join(lines), limit=100, overlap=40)

    assert len(windows) > 1
    assert all(len(window) <= 100 for window in windows)
    for previous, following in zip(windows, windows[1:], strict=False):
        assert previous.split("\n")[-1] == following.split("\n")[0]
    seen = [line for window in windows for line in window.split("\n")]
    assert sorted(set(seen)) == lines


def test_windows_respect_the_limit_when_the_overlap_meets_a_long_line() -> None:
    text = "\n".join(["a" * 50, "b" * 10, "c" * 95, "d" * 5])
    windows = transcript_windows(text, limit=100, overlap=20)
    assert all(len(window) <= 100 for window in windows), [len(w) for w in windows]
    assert "c" * 95 in "\n".join(windows)


def test_a_long_single_line_is_cut() -> None:
    text = "y" * 250
    windows = transcript_windows(text, limit=100, overlap=10)
    assert all(len(window) <= 100 for window in windows)
    assert "".join(windows).count("y") >= 250


def test_source_fingerprint_is_order_independent_and_follows_text() -> None:
    a = Transcript(id="c1", label="A", created_at=None, text="one")
    b = Transcript(id="c2", label="B", created_at=None, text="two")
    changed = Transcript(id="c2", label="B", created_at=None, text="two!")
    relabelled = Transcript(id="c2", label="Other", created_at="2026", text="two")

    assert source_fingerprint([a, b]) == source_fingerprint([b, a])
    assert source_fingerprint([a, b]) != source_fingerprint([a, changed])
    assert source_fingerprint([a, b]) == source_fingerprint([a, relabelled])
    assert source_fingerprint([a]) != source_fingerprint([a, b])


# ── consolidation ───────────────────────────────────────────────────────


def _candidate(
    statement: str,
    *,
    kind: str = "argument",
    valence: str = "positive",
    quotes: int = 1,
    rank: int = 0,
    order: tuple[int, int] = (0, 0),
    conversation_id: str = "c1",
) -> dict[str, Any]:
    return {
        "id": recipe.candidate_id(conversation_id, statement, kind) + f"-{rank}-{order[1]}",
        "conversation_id": conversation_id,
        "statement": statement,
        "kind": kind,
        "valence": valence,
        "quotes": [f"{statement} quote {i}" for i in range(quotes)],
        "order": list(order),
        "conversation_rank": rank,
    }


def _unit(angle_degrees: float) -> list[float]:
    radians = math.radians(angle_degrees)
    return [math.cos(radians), math.sin(radians), 0.0]


def _statements(groups: list[list[dict[str, Any]]]) -> list[list[str]]:
    return [[c["statement"] for c in group] for group in groups]


def test_identical_statements_merge_without_a_threshold() -> None:
    a = _candidate("Bike lanes make streets safer.", rank=0)
    b = _candidate("bike lanes   make streets SAFER.", rank=1, conversation_id="c2")
    near = _candidate("Cycle lanes make the streets safer.", rank=2)
    vectors = {
        input_hash(a["statement"]): _unit(0),
        input_hash(b["statement"]): _unit(0),
        input_hash(near["statement"]): _unit(1),
    }

    groups = consolidate([a, b, near], vectors, None)

    assert _statements(groups) == [
        ["Bike lanes make streets safer.", "bike lanes   make streets SAFER."],
        ["Cycle lanes make the streets safer."],
    ]


def test_near_duplicates_merge_only_above_threshold_with_same_kind_and_valence() -> None:
    base = _candidate("Parking should be cheaper.", order=(0, 0))
    near = _candidate("Parking ought to cost less.", order=(0, 1))
    far = _candidate("The park needs more benches.", order=(0, 2))
    other_kind = _candidate("Parking costs four euros an hour.", kind="claim", order=(0, 3))
    other_valence = _candidate("Parking must not be cheaper.", valence="negative", order=(0, 4))
    vectors = {
        input_hash(base["statement"]): _unit(0),
        input_hash(near["statement"]): _unit(5),  # cos 0.996
        input_hash(far["statement"]): _unit(60),  # cos 0.5
        input_hash(other_kind["statement"]): _unit(1),
        input_hash(other_valence["statement"]): _unit(2),
    }

    groups = consolidate([base, near, far, other_kind, other_valence], vectors, 0.9)

    assert _statements(groups) == [
        ["Parking should be cheaper.", "Parking ought to cost less."],
        ["The park needs more benches."],
        ["Parking costs four euros an hour."],
        ["Parking must not be cheaper."],
    ]


def test_opposite_valence_is_never_merged_even_for_identical_statements() -> None:
    yes = _candidate("The square should be car free.", valence="positive")
    no = _candidate("The square should be car free.", valence="negative", order=(0, 1))
    vectors = {input_hash(yes["statement"]): _unit(0)}

    for threshold in (None, 0.5):
        groups = consolidate([yes, no], vectors, threshold)
        assert len(groups) == 2
        assert {group[0]["valence"] for group in groups} == {"positive", "negative"}


def test_complete_linkage_does_not_chain_small_steps() -> None:
    a = _candidate("A", order=(0, 0))
    b = _candidate("B", order=(0, 1))
    c = _candidate("C", order=(0, 2))
    # a~b and b~c reach 0.85 (30 degrees apart); a and c (60 degrees) do not.
    vectors = {input_hash("A"): _unit(0), input_hash("B"): _unit(30), input_hash("C"): _unit(60)}

    groups = consolidate([a, b, c], vectors, 0.85)

    assert len(groups) == 2
    assert all(len(group) < 3 for group in groups)
    assert sorted(len(group) for group in groups) == [1, 2]


def test_missing_vectors_match_nothing_but_identical_statements() -> None:
    a = _candidate("Same words", order=(0, 0))
    b = _candidate("same words", order=(0, 1))
    c = _candidate("Different words", order=(0, 2))
    assert _statements(consolidate([a, b, c], {}, 0.1)) == [["Same words", "same words"], ["Different words"]]
    assert consolidate([], {}, 0.8) == []


def test_groups_are_ordered_by_their_earliest_candidate() -> None:
    late = _candidate("Late", rank=1, order=(0, 0))
    early = _candidate("Early", rank=0, order=(2, 5))
    assert _statements(consolidate([late, early], {}, None)) == [["Early"], ["Late"]]


def test_representative_prefers_most_quotes_then_earliest() -> None:
    few = _candidate("Few quotes", quotes=1, rank=0)
    many = _candidate("Many quotes", quotes=3, rank=2)
    many_earlier = _candidate("Many quotes, earlier", quotes=3, rank=1)
    assert representative([few, many, many_earlier])["statement"] == "Many quotes, earlier"
    tie_a = _candidate("Tie A", quotes=2, rank=0, order=(1, 0))
    tie_b = _candidate("Tie B", quotes=2, rank=0, order=(0, 7))
    assert representative([tie_a, tie_b])["statement"] == "Tie B"


def test_merge_threshold_is_per_model_and_unknown_models_merge_nothing_similar() -> None:
    assert recipe.merge_threshold_for("vertex_ai/text-embedding-004") == 0.80
    assert recipe.merge_threshold_for("gemini-embedding-001") == 0.92
    assert recipe.merge_threshold_for("text-embedding-3-small") is None


# ── manifest ────────────────────────────────────────────────────────────


def _transcripts() -> list[Transcript]:
    return [
        Transcript(id="c1", label="Ann", created_at="2026-09-01T10:00:00Z", text="..."),
        Transcript(id="c2", label="Bob", created_at="2026-09-03T10:00:00Z", text="..."),
    ]


def test_manifest_keeps_every_conversations_evidence_and_claim_keys_only_for_claims() -> None:
    argument_a = {**_candidate("Trams beat buses.", quotes=2), "quotes": ["trams", "Trams!"]}
    argument_b = {
        **_candidate("Trams beat buses.", rank=1, conversation_id="c2"),
        "quotes": ["TRAMS", "rails please"],
    }
    claim = _candidate("The tram line opened in 1998.", kind="claim", valence="neutral")
    groups = [[argument_a, argument_b], [claim]]
    embedding_ids = {input_hash("Trams beat buses."): "e1", input_hash(claim["statement"]): "e2"}

    manifest = build_manifest(
        groups, _transcripts(), embedding_ids, stats={"n": 1}, consolidation={"rule": "r"}
    )

    assert manifest["version"] == recipe.MANIFEST_VERSION
    assert manifest["recipe_version"] == recipe.RECIPE_VERSION
    assert manifest["stats"] == {"n": 1}
    assert manifest["consolidation"] == {"rule": "r"}
    assert [c["id"] for c in manifest["conversations"]] == ["c1", "c2"]
    first, second = manifest["arguments"]
    assert first["evidence"] == [
        {
            "conversation_id": "c1",
            "label": "Ann",
            "created_at": "2026-09-01T10:00:00Z",
            "quotes": ["trams", "Trams!"],
        },
        {
            "conversation_id": "c2",
            "label": "Bob",
            "created_at": "2026-09-03T10:00:00Z",
            "quotes": ["TRAMS", "rails please"],
        },
    ]
    assert first["claim_key"] is None
    assert first["embedding_id"] == "e1"
    assert first["input_hash"] == input_hash("Trams beat buses.")
    assert first["created_at"] == "2026-09-03T10:00:00Z"
    assert first["candidate_ids"] == [argument_a["id"], argument_b["id"]]
    assert first["id"] == recipe.node_id("Trams beat buses.", "argument")
    assert second["kind"] == "claim"
    assert second["claim_key"] == claim_key(claim["statement"], claim["quotes"])


def test_manifest_raises_when_an_embedding_id_is_missing() -> None:
    groups = [[_candidate("Unembedded")]]
    with pytest.raises(KeyError):
        build_manifest(groups, _transcripts(), {}, stats={}, consolidation={})


def test_claim_key_follows_statement_and_evidence_only() -> None:
    base = claim_key("The bridge opened in 1932.", ["it opened in 1932", "the old bridge"])
    assert base == claim_key("the bridge  opened in 1932.", ["THE OLD BRIDGE", "it opened in 1932"])
    assert base != claim_key("The bridge opened in 1933.", ["it opened in 1932", "the old bridge"])
    assert base != claim_key("The bridge opened in 1932.", ["it opened in 1932"])


# ── vectors ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "values",
    [
        [0.1, 0.2],
        [0.1, 0.2, 0.3, 0.4],
        [0.1, float("nan"), 0.3],
        [0.1, float("inf"), 0.3],
        [0.1, "high", 0.3],
        [0.1, None, 0.3],
        [0.0, 0.0, 0.0],
        "0.1,0.2,0.3",
        None,
    ],
)
def test_validate_vector_rejects_unusable_vectors(values: Any) -> None:
    with pytest.raises(InvalidVector):
        validate_vector(values, 3)


def test_validate_vector_returns_floats() -> None:
    assert validate_vector([1, 0, "0.5"], 3) == [1.0, 0.0, 0.5]
    assert validate_vector((0.0, -2.0), 2) == [0.0, -2.0]


# ── titles ──────────────────────────────────────────────────────────────


def _argument(statement: str, *, kind: str = "argument", key: str | None = None) -> dict[str, Any]:
    return {"id": statement, "statement": statement, "kind": kind, "claim_key": key}


def test_title_lines_tag_arguments_and_claims_with_verdicts() -> None:
    lines = title_lines(
        [
            _argument("Trams are quiet."),
            _argument("Trams cost 1 billion.", kind="claim", key="k1"),
            _argument("Trams run at night.", kind="claim", key="k2"),
            _argument("Buses are cheap.", kind="claim", key=None),
        ],
        {"k1": "false", "k2": None},
    )
    assert lines == [
        "1. [argument] Trams are quiet.",
        "2. [claim, false] Trams cost 1 billion.",
        "3. [claim, unverified] Trams run at night.",
        "4. [claim, unverified] Buses are cheap.",
    ]


def test_title_lines_refuse_too_small_and_too_large_selections() -> None:
    with pytest.raises(SelectionTooSmall):
        title_lines([_argument("one"), _argument("two")], {})
    huge = "z" * (recipe.MAX_TITLE_CHARS // 2)
    with pytest.raises(SelectionTooLarge):
        title_lines([_argument(huge), _argument(huge), _argument("three")], {})


def test_title_selection_key_is_order_independent_and_follows_config() -> None:
    key = title_selection_key("r1", ["b", "a", "c"], "prompt|model")
    assert key == title_selection_key("r1", ["c", "a", "b", "a"], "prompt|model")
    assert key != title_selection_key("r1", ["a", "b", "c"], "prompt-v2|model")
    assert key != title_selection_key("r2", ["a", "b", "c"], "prompt|model")
    assert key != title_selection_key("r1", ["a", "b"], "prompt|model")
