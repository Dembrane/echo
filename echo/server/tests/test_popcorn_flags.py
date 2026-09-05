from __future__ import annotations

from dembrane.popcorn.flags import (
    gate_items,
    known_run,
    scrub_names,
    known_shingles,
    introduced_names,
)

TRANSCRIPT = """Hi, I'm Priya, I run the Tuesday group. Thanks, Tom, that's kind.
Nobody joins for the desks. What Aisha was saying is right: the kettle is the real reception.
Okay, so where do we go from here? Yeah, agreed."""


def test_introduced_names_finds_introductions_and_addresses() -> None:
    assert introduced_names(TRANSCRIPT) == {"Priya", "Tom", "Aisha"}
    assert introduced_names("Okay, so. Yeah, right.") == set()


def test_scrub_names_replaces_a_name_and_its_possessive() -> None:
    assert scrub_names("Priya's point about Tom", {"Priya", "Tom"}) == (
        "a participant point about a participant"
    )


def test_known_shingles_come_from_everything_the_room_was_shown() -> None:
    state = {
        "conversations": {
            "c1": {"items": [{"phrase": "one two three four five six seven"}]},
        },
        "analysis": {
            "tensions": {"tensions": [{"poleA": "a b c d e f g", "id": "x1"}]},
        },
        "quotes": [{"id": "q1", "text": "alpha beta gamma delta epsilon zeta eta", "url": "x"}],
    }
    known = known_shingles(state)
    assert ("one", "two", "three", "four", "five", "six") in known
    assert ("a", "b", "c", "d", "e", "f") in known
    assert ("beta", "gamma", "delta", "epsilon", "zeta", "eta") in known
    # A run never crosses from one text into the next.
    assert ("six", "seven", "a", "b", "c", "d") not in known
    assert known_run("they said one two three four five six", known) == "one two three four five six"
    assert known_run("one two three four", known) is None
    assert known_shingles({}) == set()


def test_gate_items_holds_back_names_known_text_and_twins() -> None:
    known = known_shingles({"conversations": {"c": {"items": [{"phrase": "the kettle is the real reception here"}]}}})
    items = [
        {"id": "1", "phrase": "Nobody joins for the desks", "weight": 2},
        {"id": "2", "phrase": "Priya runs the Tuesday group", "weight": 1},
        {"id": "3", "phrase": "the kettle is the real reception here", "weight": 3},
        {"id": "4", "phrase": "Joining is never for the desks", "weight": 3},  # a heavier twin of 1
        {"id": "5", "phrase": "Desks are not why anybody joins", "weight": 1},  # a lighter twin
    ]
    kept, suppressed = gate_items(items, names={"Priya"}, known=known)
    assert [k["id"] for k in kept] == ["4"]
    reasons = {s["id"]: s["reason"] for s in suppressed}
    assert "name" in reasons["2"] and "Priya" in reasons["2"]
    assert "text the room was shown" in reasons["3"]
    assert reasons["1"].startswith("says what") and "less weight" in reasons["1"]
    assert reasons["5"].startswith("says what")
    # Nothing to hold back: everything passes in order.
    plain = [{"id": "a", "phrase": "quiet is a service we sell", "weight": 1}]
    assert gate_items(plain, names=set(), known=set()) == (plain, [])
