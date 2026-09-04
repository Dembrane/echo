from __future__ import annotations

from dembrane.popcorn.service import (
    build_bundle,
    sample_bundle,
    normalize_state,
    voice_host_note,
    normalize_settings,
)
from dembrane.popcorn.grounding import is_verbatim, ground_items, closest_passage

TRANSCRIPT = """Facilitator: So, table one, what does membership actually mean here?
Priya: Honestly, nobody joins for the desks. I could get a desk anywhere cheaper.
Tom: The kettle is the real reception. Half the useful conversations start waiting for it to boil.
Aisha: We should be honest that the Tuesday crowd and the Thursday crowd have never met."""


def test_verbatim_is_case_and_whitespace_tolerant() -> None:
    assert is_verbatim("Nobody joins for the desks", TRANSCRIPT)
    assert is_verbatim("the kettle is the  real reception", TRANSCRIPT)
    assert not is_verbatim("Membership is about belonging", TRANSCRIPT)


def test_closest_passage_uses_rare_words() -> None:
    hit = closest_passage("Two crowds that have never met", TRANSCRIPT)
    assert hit is not None
    assert "Tuesday crowd" in hit["text"]
    # One shared common word is not evidence.
    assert closest_passage("What does it mean", TRANSCRIPT) is None
    assert closest_passage("", TRANSCRIPT) is None


def test_ground_items_marks_verbatim_and_source() -> None:
    items = ground_items(
        [
            {"id": "p-1", "phrase": "Nobody joins for the desks", "weight": 3},
            {"id": "p-2", "phrase": "Two crowds that never met", "weight": 2},
            {"id": "p-3", "phrase": "Unrelated wording entirely", "weight": 1},
        ],
        TRANSCRIPT,
    )
    assert items[0]["verbatim"] is True
    assert items[1]["verbatim"] is False and "Tuesday" in items[1]["source"]["text"]
    assert items[2]["verbatim"] is False and items[2]["source"] is None


def test_voice_host_note() -> None:
    assert voice_host_note({"presets": [], "note": ""}) == ""
    gentle = voice_host_note({"presets": ["gentle"], "note": "  keep it   warm "})
    assert gentle.startswith("Prefer the gentler")
    assert gentle.endswith("keep it warm")
    assert voice_host_note({"presets": ["nope"]}) == ""
    both = voice_host_note({"presets": ["plain", "gentle"]})
    assert both.index("Prefer the gentler") < both.index("Prefer the plainest")
    assert normalize_settings({"voice": {"preset": "plain"}}, fallback_title="x")["voice"] == {
        "presets": ["plain"],
        "note": "",
    }


def _grounded_state() -> dict:
    return normalize_state(
        {
            "run": 3,
            "order": ["c1"],
            "conversations": {
                "c1": {
                    "id": "c1",
                    "label": "Table 1",
                    "short": "Table 1",
                    "done": True,
                    "revision": 2,
                    "validated_run": 3,
                    "items": [
                        {
                            "id": "p-c1-1",
                            "phrase": "Nobody joins for the desks",
                            "weight": 3,
                            "quoteId": "q1",
                        },
                        {
                            "id": "p-c1-2",
                            "phrase": "Two crowds that never met",
                            "weight": 2,
                            "source": {
                                "text": "the Tuesday crowd and the Thursday crowd have never met"
                            },
                        },
                    ],
                }
            },
            "analysis": {
                "quotes": [{"id": "q1", "transcript": "c1", "text": "Nobody joins for the desks"}],
                "tensions": {"tensions": []},
                "stakeholders": {"stakeholders": [], "relations": []},
            },
        }
    )


def test_host_bundle_carries_sources_and_links_but_public_does_not() -> None:
    report = {"id": "r1", "date_created": None}
    project = {"id": "p1", "workspace_id": "w1", "language": "en", "is_conversation_allowed": True}
    settings = normalize_settings({}, fallback_title="Popcorn")
    common = dict(
        state=_grounded_state(),
        settings=settings,
        report=report,
        project=project,
        participant_base_url="https://portal.dembrane.com",
        admin_base_url="https://dashboard.dembrane.com",
    )
    host = build_bundle(host=True, **common)["files"]
    public = build_bundle(host=False, **common)["files"]

    assert host["session.json"]["host"] == {
        "tabs": {"tensions": True, "stakeholders": True},
        "qr": False,
        "qrAvailable": True,
    }
    assert "host" not in public["session.json"]
    assert public["session.json"]["branding"] is True
    assert host["popcorn/c1.json"]["validated"] is True
    assert host["popcorn/c1.json"]["items"][0]["quoteId"] == "q1"
    assert host["popcorn/c1.json"]["items"][1]["source"]["text"].startswith("the Tuesday")
    assert host["popcorn/c1.json"]["items"][1]["source"]["url"] == (
        "https://dashboard.dembrane.com/en-US/w/w1/projects/p1/conversations/c1"
    )
    assert host["quotes.json"]["quotes"][0]["url"].endswith("/conversations/c1")

    assert "source" not in public["popcorn/c1.json"]["items"][1]
    assert public["popcorn/c1.json"]["items"][0]["quoteId"] == "q1"
    assert "url" not in public["quotes.json"]["quotes"][0]


def test_validated_is_false_once_a_conversation_changed_after_the_pass() -> None:
    state = _grounded_state()
    state["run"] = 4  # a newer run re-read something; this conversation was not re-grounded
    files = build_bundle(
        state=state,
        settings=normalize_settings({}, fallback_title="x"),
        report={"id": "r1"},
        project={"id": "p1"},
        participant_base_url="",
    )["files"]
    assert files["popcorn/c1.json"]["validated"] is False


def test_sample_bundle_is_the_upstream_deck() -> None:
    bundle = sample_bundle()
    assert bundle["sample"] is True
    assert bundle["files"]["session.json"]["client"] == "Facilitation BV"
    assert {"popcorn/t1.json", "tensions.json", "stakeholders.json", "quotes.json"} <= set(
        bundle["files"]
    )
    assert "custom/breakthroughs.json" in bundle["files"]
