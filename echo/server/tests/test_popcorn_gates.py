from __future__ import annotations

from dembrane.popcorn.gates import name_flags, island_flags, screen_flags


def test_name_flags_catch_joined_names_and_things() -> None:
    stake = {
        "stakeholders": [
            {"id": "s1", "name": "AI/technology"},
            {"id": "s2", "name": "Staff and volunteers"},
            {"id": "s3", "name": "The recording tool"},
            {"id": "s4", "name": "The tool developers"},
            {"id": "s5", "name": "Funders"},
        ]
    }
    flags = name_flags(stake)
    assert [f.split(":")[0] for f in flags] == ["s1", "s2", "s3"]
    assert "joins two groups" in flags[0] and "names a thing" in flags[2]


def test_island_flags_want_one_map() -> None:
    stake = {
        "stakeholders": [{"id": s, "name": s.upper()} for s in ("s1", "s2", "s3", "s4", "s5")],
        "relations": [
            {"between": ["s1", "s2"]},
            {"between": ["s2", "s3"]},
            {"between": ["s4", "s5"]},
        ],
    }
    flags = island_flags(stake)
    assert len(flags) == 1 and flags[0].startswith("island: s4")
    stake["relations"].append({"between": ["s3", "s4"]})
    assert island_flags(stake) == []
    stake["stakeholders"].append({"id": "s6", "name": "S6"})
    assert island_flags(stake) == [
        "s6: 'S6' has no relation to any other group; add the relation the transcripts support, or drop the group"
    ]


def test_screen_flags_read_from_the_back_of_the_room() -> None:
    good = {
        "tensions": [
            {
                "id": "x1",
                "poleA": "record every conversation",
                "poleB": "trust the unrecorded conversation",
                "knot": "Record it and people stop thinking out loud; don't, and the good bits are gone by Friday.",
                "toResolve": "Which conversations are recorded, and who decides?",
            }
        ]
    }
    assert screen_flags(good) == []
    bad = {
        "tensions": [
            {
                "id": "x2",
                "poleA": "record",
                "poleB": "one two three four five six seven eight",
                "knot": "Participants discussed the trade-off. It was hard.",
                "toResolve": " ".join(["word"] * 23),
            }
        ]
    }
    flags = screen_flags(bad)
    assert any("poleA: 1 words, at least 3" in f for f in flags)
    assert any("poleB: 8 words, at most 7" in f for f in flags)
    assert any("more than one sentence" in f for f in flags)
    assert any("reports the meeting" in f for f in flags)
    assert any("toResolve: 23 words" in f for f in flags)
