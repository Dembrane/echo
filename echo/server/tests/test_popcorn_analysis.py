from __future__ import annotations

from dembrane.popcorn.service import build_bundle, normalize_state, normalize_settings
from dembrane.popcorn.analysis import (
    QuoteBook,
    build_corpus,
    shape_tensions,
    shape_stakeholders,
    shape_popcorn_items,
)


def test_shape_popcorn_items_applies_first_run_gates() -> None:
    raw = {
        "items": [
            {"phrase": '"Nobody joins for the desks."', "weight": 3},
            {"phrase": "Nobody joins for the desks", "weight": 2},  # near-duplicate
            {"phrase": "The kettle is the real reception!", "weight": 3},  # second weight-3
            {"phrase": "x" * 120, "weight": 1},  # over the length budget
            {"phrase": "   ", "weight": 1},
        ]
    }
    items = shape_popcorn_items(raw, "t1")
    assert [i["phrase"] for i in items] == [
        "Nobody joins for the desks",
        "The kettle is the real reception",
    ]
    assert [i["weight"] for i in items] == [3, 2]
    assert [i["id"] for i in items] == ["p-t1-1", "p-t1-2"]


def test_shape_popcorn_items_caps_at_eight_and_tolerates_junk() -> None:
    raw = {"items": [{"phrase": f"phrase {n}", "weight": 1} for n in range(12)]}
    assert len(shape_popcorn_items(raw, "t")) == 8
    assert shape_popcorn_items(None, "t") == []
    assert shape_popcorn_items({"items": "nope"}, "t") == []


def test_quote_book_refuses_non_verbatim_quotes() -> None:
    book = QuoteBook({"t1": "We said the lift has been nearly fixed for a year.\nAnd more."})
    ok = book.add({"transcript": "t1", "text": "the lift has been nearly fixed for a year"})
    misattributed = book.add({"transcript": "t9", "text": "And more."})
    invented = book.add({"transcript": "t1", "text": "the lift works perfectly"})
    assert ok == "q1"
    assert misattributed == "q2"
    assert book.quotes[1]["transcript"] == "t1"
    assert invented is None
    assert book.rejected == 1
    # The same quote twice is one registry entry.
    assert (
        book.add({"transcript": "t1", "text": "The lift has been  nearly fixed for a year"}) == "q1"
    )


def test_shape_stakeholders_drops_aspects_without_a_verbatim_quote() -> None:
    book = QuoteBook({"t1": "the board never tells the members anything"})
    raw = {
        "stakeholders": [
            {
                "name": "Members",
                "role": "people who pay",
                "stake": "to be told first",
                "rung": "voiced",
                "stakeWeight": 0.9,
                "mentionsWeight": 0.8,
                "quotes": [],
            },
            {
                "name": "The board",
                "role": "who decides",
                "stake": "to decide quickly",
                "rung": "named",
                "stakeWeight": 0.5,
                "mentionsWeight": 0.4,
                "quotes": [],
            },
        ],
        "relations": [
            {
                "between": ["Members", "The board"],
                "label": "told after the fact",
                "intensity": 0.7,
                "sentiment": -0.4,
                "unowned": True,
                "detail": "Decisions arrive as announcements.",
                "aspects": [
                    {
                        "kind": "power",
                        "note": "The board decides alone.",
                        "quotes": [
                            {
                                "transcript": "t1",
                                "text": "the board never tells the members anything",
                            }
                        ],
                    },
                    {
                        "kind": "risk",
                        "note": "Made up.",
                        "quotes": [{"transcript": "t1", "text": "this was never said"}],
                    },
                ],
            },
            {
                "between": ["Members", "Nobody"],
                "label": "x",
                "intensity": 0.1,
                "sentiment": 0,
                "unowned": False,
                "detail": "a relation to nobody",
                "aspects": [],
            },
        ],
    }
    shaped = shape_stakeholders(raw, book)
    assert [s["id"] for s in shaped["stakeholders"]] == ["s1", "s2"]
    assert len(shaped["relations"]) == 1
    assert [a["kind"] for a in shaped["relations"][0]["aspects"]] == ["power"]
    assert shaped["relations"][0]["between"] == ["s1", "s2"]


def test_shape_tensions_and_corpus() -> None:
    book = QuoteBook({"t1": "quiet is a service we sell"})
    raw = {
        "tensions": [
            {
                "poleA": "a",
                "poleB": "b",
                "narrative": "n",
                "toResolve": "q",
                "quotes": [{"transcript": "t1", "text": "quiet is a service we sell"}],
            }
        ]
    }
    shaped = shape_tensions(raw, book)
    assert shaped["tensions"][0]["id"] == "x1"
    assert shaped["tensions"][0]["quoteIds"] == ["q1"]
    corpus = build_corpus([("t1", "hello"), ("t2", "world")])
    assert "TRANSCRIPT id: t1\nhello\nEND TRANSCRIPT t1" in corpus


def _state() -> dict:
    return normalize_state(
        {
            "run": 2,
            "order": ["c2", "c1"],
            "conversations": {
                "c1": {
                    "id": "c1",
                    "label": "Table 1",
                    "short": "Table 1",
                    "done": True,
                    "revision": 1,
                    "items": [{"id": "p-c1-1", "phrase": "one", "weight": 2}],
                },
                "c2": {
                    "id": "c2",
                    "label": "Table 2",
                    "short": "Table 2",
                    "done": False,
                    "revision": 0,
                    "items": [],
                },
            },
            "analysis": {
                "quotes": [{"id": "q1", "transcript": "c1", "text": "one"}],
                "tensions": {"tensions": []},
                "stakeholders": {"stakeholders": [], "relations": []},
            },
        }
    )


def test_build_bundle_hides_tabs_and_carries_qr() -> None:
    report = {"id": "r1", "date_created": "2026-09-03T10:00:00+00:00"}
    project = {"id": "p1", "language": "nl", "is_conversation_allowed": True}
    settings = normalize_settings(
        {
            "title": "Members' day",
            "client": "Sorted",
            "tabs": {"stakeholders": False},
            "show_qr": True,
        },
        fallback_title="Popcorn",
    )
    bundle = build_bundle(
        state=_state(),
        settings=settings,
        report=report,
        project=project,
        participant_base_url="https://portal.dembrane.com",
    )
    files = bundle["files"]
    assert bundle["run"] == 2
    assert files["session.json"]["title"] == "Members' day"
    assert files["session.json"]["date"] == "3 September 2026"
    assert [t["id"] for t in files["session.json"]["transcripts"]] == ["c2", "c1"]
    assert files["session.json"]["qr"]["url"] == (
        "https://portal.dembrane.com/nl-NL/p1/start?utm_source=popcorn_qr"
    )
    svg = files["session.json"]["qr"]["svg"]
    assert svg.startswith("<svg") and 'href="logo.png"' in svg and "<circle" in svg
    assert files["popcorn/c1.json"]["items"][0]["phrase"] == "one"
    assert files["popcorn/c1.json"]["validated"] is False
    assert files["popcorn/c2.json"]["done"] is False
    assert "tensions.json" in files
    assert "stakeholders.json" not in files
    assert files["quotes.json"]["quotes"][0]["id"] == "q1"


def test_build_bundle_without_qr_or_participation() -> None:
    report = {"id": "r1", "date_created": None}
    project = {"id": "p1", "language": "en", "is_conversation_allowed": False}
    settings = normalize_settings({"show_qr": True}, fallback_title="Popcorn")
    bundle = build_bundle(
        state=_state(),
        settings=settings,
        report=report,
        project=project,
        participant_base_url="https://portal.dembrane.com",
    )
    assert "qr" not in bundle["files"]["session.json"]
    assert bundle["files"]["session.json"]["title"] == "Popcorn"
