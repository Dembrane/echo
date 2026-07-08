from __future__ import annotations

from dembrane.official_methodologies import DEMBRANE_METHODOLOGY, OFFICIAL_METHODOLOGIES


def test_official_methodologies_registry_contains_default_dembrane_methodology() -> None:
    assert [methodology.name for methodology in OFFICIAL_METHODOLOGIES] == ["dembrane"]
    assert DEMBRANE_METHODOLOGY.visibility == "public"
    assert DEMBRANE_METHODOLOGY.version_note == "Official dembrane methodology v2"


def test_dembrane_methodology_guides_group_project_definition() -> None:
    content = DEMBRANE_METHODOLOGY.content
    searchable = " ".join(
        [
            DEMBRANE_METHODOLOGY.framing,
            str(content.get("opening_move", "")),
            str(content.get("description", "")),
            " ".join(str(question) for question in content.get("setup_questions", [])),
            str(content.get("collection_guidance", "")),
        ]
    ).lower()

    assert "how many people" in searchable
    assert "collect input" in searchable
    assert "phone" in searchable
    assert "dembrane go" in searchable
    assert "consent" in searchable
    assert "interview" not in searchable
