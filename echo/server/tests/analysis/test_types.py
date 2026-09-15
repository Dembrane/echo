from __future__ import annotations

import pytest

from dembrane.map import recipe as map_recipe
from dembrane.analysis import types
from dembrane.analysis.contracts import RelationBasis, AnalysisValidationError

TENSION = {
    "poleA": "More buses",
    "poleB": "Fewer cars",
    "knot": "Both claim the same street.",
    "toResolve": "Who gets the lane?",
    "quotes": [{"text": "we need buses", "pole": "A", "conversationId": "c1"}],
}


def test_the_built_in_types_and_relations_are_registered() -> None:
    assert {t.id for t in types.object_types()} >= {
        "argument",
        "deduplicated_argument",
        "popcorn",
        "tension",
        "stakeholder",
        "fact_check_assessment",
    }
    assert {r.id for r in types.relation_types()} >= {
        "supports_pole_a",
        "supports_pole_b",
        "holds_position",
        "affected_by",
        "stakeholder_relation",
        "derived_from",
        "assesses",
    }


def test_unknown_types_fail_validation() -> None:
    with pytest.raises(types.UnknownType):
        types.validate_payload("opinion", {"text": "x"})
    with pytest.raises(types.UnknownType):
        types.validate_relation("contradicts", from_type="argument", to_type="argument", basis="extracted", attributes={})


def test_a_tension_keeps_the_deck_contract() -> None:
    clean = types.validate_payload("tension", TENSION)
    assert set(clean) == {"poleA", "poleB", "knot", "toResolve", "quotes"}
    detail = types.get_object_type("tension").map.detail(clean)  # type: ignore[union-attr]
    assert detail["narrative"] == "Both claim the same street."
    with pytest.raises(types.InvalidPayload, match="knot"):
        types.validate_payload("tension", {k: v for k, v in TENSION.items() if k != "knot"})
    with pytest.raises(types.InvalidPayload):
        types.validate_payload("tension", {**TENSION, "narrative": "not the field name"})


def test_attributes_and_fact_check_eligibility_follow_the_argument_kind() -> None:
    claim = types.validate_payload("argument", {"statement": "The bridge opened in 1932.", "epistemicKind": "claim", "valence": "neutral"})
    argument = types.validate_payload("argument", {"statement": "Trams are better.", "epistemicKind": "argument"})
    assert types.attributes_for("argument", claim) == {"valence": "neutral", "epistemicKind": "claim"}
    assert types.attributes_for("argument", argument) == {"epistemicKind": "argument"}
    assert types.fact_check_eligible("argument", claim, types.attributes_for("argument", claim))
    assert not types.fact_check_eligible("argument", argument, {})
    assert not types.fact_check_eligible("tension", types.validate_payload("tension", TENSION), {})


def test_an_argument_projection_is_exactly_maps_embedding_input() -> None:
    statement = "  Trams   are\nbetter  "
    projection = types.get_object_type("argument").map
    assert projection is not None
    assert projection.embedding_text({"statement": statement}) == map_recipe.embedding_input(statement)
    assert projection.projection_version == "statement-v1"


def test_relations_check_endpoints_bases_and_attributes() -> None:
    attributes = {
        "label": "depends on",
        "intensity": 0.5,
        "sentiment": -0.2,
        "unowned": False,
        "detail": "The shops depend on the market for customers.",
        "aspects": [{"kind": "power", "note": "The market sets the hours.", "quotes": [{"text": "they decide"}]}],
    }
    clean = types.validate_relation(
        "stakeholder_relation", from_type="stakeholder", to_type="stakeholder", basis="extracted", attributes=attributes
    )
    assert set(clean) == {"label", "intensity", "sentiment", "unowned", "detail", "aspects"}
    with pytest.raises(AnalysisValidationError, match="cannot start at a tension"):
        types.validate_relation("supports_pole_a", from_type="tension", to_type="tension", basis="extracted", attributes={})
    with pytest.raises(AnalysisValidationError, match="cannot be recorded as inferred"):
        types.validate_relation("assesses", from_type="fact_check_assessment", to_type="argument", basis=RelationBasis.INFERRED, attributes=None)
    with pytest.raises(types.InvalidPayload):
        types.validate_relation("stakeholder_relation", from_type="stakeholder", to_type="stakeholder", basis="extracted", attributes={**attributes, "intensity": 3})
