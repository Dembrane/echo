"""Registered object and relation types.

An object type names its payload schema (a pydantic model, validated strictly),
how to read its attributes, and its capabilities: whether it can appear on the
Map (label, detail, a versioned embedding-text projection) and whether it can be
fact-checked. A relation type names its allowed endpoint types, the bases it may
be recorded with and, where it has them, its attribute schema.

Unknown types fail validation. Extensions register namespaced ids
(`vendor.thing`) through the same functions.
"""

from __future__ import annotations

import threading
from typing import Any, Literal, Callable
from dataclasses import field, dataclass

from pydantic import Field, BaseModel, ConfigDict, ValidationError

from dembrane.analysis.contracts import RelationBasis, AnalysisValidationError

Valence = Literal["positive", "negative", "neutral"]
EpistemicKind = Literal["argument", "claim"]


class UnknownType(AnalysisValidationError):
    pass


class InvalidPayload(AnalysisValidationError):
    def __init__(self, type_id: str, errors: list[dict[str, Any]]) -> None:
        detail = "; ".join(
            f"{'.'.join(str(p) for p in error.get('loc', ())) or '(root)'}: {error.get('msg')}"
            for error in errors[:5]
        )
        super().__init__(f"invalid {type_id} payload: {detail}")
        self.type_id = type_id
        self.errors = errors


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)


# ── payload schemas ─────────────────────────────────────────────────────


class Evidence(Payload):
    """Quotes from one conversation, as the Map manifest records them."""

    conversationId: str = Field(min_length=1)
    label: str | None = None
    createdAt: str | None = None
    quotes: list[str] = Field(default_factory=list)


class QuoteRef(Payload):
    text: str = Field(min_length=1)
    conversationId: str | None = None
    location: dict[str, Any] | None = None


class ArgumentPayload(Payload):
    statement: str = Field(min_length=1)
    epistemicKind: EpistemicKind
    valence: Valence | None = None
    evidence: list[Evidence] = Field(default_factory=list)


class Consolidation(Payload):
    """How a deduplicated argument came to be: its members are `derived_from`
    relations; this records the strategy, coverage and verification."""

    strategy: str = Field(min_length=1)
    memberCount: int = Field(ge=1)
    verification: Literal["verified", "singleton", "uncertain"]
    rationale: str | None = None
    coverage: dict[str, Any] = Field(default_factory=dict)


class DeduplicatedArgumentPayload(ArgumentPayload):
    consolidation: Consolidation


class PopcornPayload(Payload):
    phrase: str = Field(min_length=1, max_length=90)
    question: bool = False
    language: str | None = None
    evidence: list[Evidence] = Field(default_factory=list)


class TensionQuote(QuoteRef):
    pole: Literal["A", "B"] | None = None


class TensionPayload(Payload):
    """The deck's contract: `knot` is the narrative the Map inspector shows."""

    poleA: str = Field(min_length=1)
    poleB: str = Field(min_length=1)
    knot: str = Field(min_length=1)
    toResolve: str = Field(min_length=1)
    quotes: list[TensionQuote] = Field(default_factory=list)


class StakeholderWeight(Payload):
    stake: float = Field(ge=0, le=1)
    mentions: float = Field(ge=0, le=1)


class StakeholderPayload(Payload):
    name: str = Field(min_length=1)
    role: str = Field(min_length=1)
    stake: str = Field(min_length=1)
    rung: Literal["voiced", "named", "inferred"]
    invokedBy: str | None = None
    weight: StakeholderWeight
    quotes: list[QuoteRef] = Field(default_factory=list)


class AssessmentSource(Payload):
    url: str = Field(min_length=1)
    title: str | None = None


class FactCheckAssessmentPayload(Payload):
    verdict: str = Field(min_length=1)
    justification: str = ""
    sources: list[AssessmentSource] = Field(default_factory=list)
    statement: str = Field(min_length=1)
    claimKey: str | None = None
    model: str | None = None
    promptVersion: str | None = None


class StakeholderAspect(Payload):
    kind: Literal["power", "risk", "opportunity"]
    note: str = Field(min_length=1)
    quotes: list[QuoteRef] = Field(default_factory=list)


class StakeholderRelationAttributes(Payload):
    label: str = Field(min_length=1)
    intensity: float = Field(ge=0, le=1)
    sentiment: float = Field(ge=-1, le=1)
    unowned: bool
    detail: str = Field(min_length=1)
    aspects: list[StakeholderAspect] = Field(default_factory=list)


class EvidenceAttributes(Payload):
    """What most extracted relations carry: why, and the quotes that hold it."""

    rationale: str | None = None
    quotes: list[QuoteRef] = Field(default_factory=list)


# ── capabilities ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MapCapability:
    label: Callable[[dict[str, Any]], str]
    detail: Callable[[dict[str, Any]], dict[str, Any]]
    embedding_text: Callable[[dict[str, Any]], str]
    # Part of the embedding cache input: a projection change is new text,
    # never a rewrite of stored vectors.
    projection_version: str


@dataclass(frozen=True)
class FactCheckCapability:
    eligible: Callable[[dict[str, Any], dict[str, Any]], bool]
    statement: Callable[[dict[str, Any]], str]


@dataclass(frozen=True)
class ObjectType:
    id: str
    schema_version: int
    payload_model: type[Payload]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] = lambda _payload: {}
    map: MapCapability | None = None
    fact_check: FactCheckCapability | None = None
    description: str = ""

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "schemaVersion": self.schema_version,
            "description": self.description,
            "payloadSchema": self.payload_model.model_json_schema(),
            "mapCapable": self.map is not None,
            "embeddingProjectionVersion": self.map.projection_version if self.map else None,
            "factCheckable": self.fact_check is not None,
        }


@dataclass(frozen=True)
class RelationType:
    id: str
    from_types: frozenset[str]
    to_types: frozenset[str]
    bases: frozenset[RelationBasis]
    attributes_model: type[Payload] | None = None
    description: str = ""

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "from": sorted(self.from_types),
            "to": sorted(self.to_types),
            "bases": sorted(str(basis) for basis in self.bases),
            "attributesSchema": self.attributes_model.model_json_schema()
            if self.attributes_model
            else None,
            "description": self.description,
        }


@dataclass(frozen=True)
class AttributeDefinition:
    """What a view may color or filter by. Values are categorical; a missing
    value has its own label and is never folded into a real one."""

    id: str
    label: str
    applies_to: frozenset[str]
    values: tuple[str, ...]
    missing: str
    description: str = ""
    notes: dict[str, str] = field(default_factory=dict)

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "appliesTo": sorted(self.applies_to),
            "values": list(self.values),
            "missing": self.missing,
            "description": self.description,
        }


_lock = threading.Lock()
_object_types: dict[str, ObjectType] = {}
_relation_types: dict[str, RelationType] = {}


def register_object_type(definition: ObjectType, *, replace: bool = False) -> ObjectType:
    with _lock:
        if definition.id in _object_types and not replace:
            raise ValueError(f"object type {definition.id} is already registered")
        _object_types[definition.id] = definition
    return definition


def register_relation_type(definition: RelationType, *, replace: bool = False) -> RelationType:
    with _lock:
        if definition.id in _relation_types and not replace:
            raise ValueError(f"relation type {definition.id} is already registered")
        unknown = sorted((definition.from_types | definition.to_types) - set(_object_types))
        if unknown:
            raise UnknownType(f"relation type {definition.id} names unknown object types: {unknown}")
        _relation_types[definition.id] = definition
    return definition


def unregister_type(type_id: str) -> None:
    """For tests and extensions that registered a temporary type."""
    with _lock:
        _object_types.pop(type_id, None)
        _relation_types.pop(type_id, None)


def get_object_type(type_id: str) -> ObjectType:
    definition = _object_types.get(type_id)
    if definition is None:
        raise UnknownType(f"unknown object type {type_id!r}")
    return definition


def get_relation_type(type_id: str) -> RelationType:
    definition = _relation_types.get(type_id)
    if definition is None:
        raise UnknownType(f"unknown relation type {type_id!r}")
    return definition


def object_types() -> list[ObjectType]:
    return sorted(_object_types.values(), key=lambda t: t.id)


def relation_types() -> list[RelationType]:
    return sorted(_relation_types.values(), key=lambda t: t.id)


def validate_payload(type_id: str, payload: Any) -> dict[str, Any]:
    """The payload as its type's schema normalises it, or InvalidPayload."""
    definition = get_object_type(type_id)
    try:
        model = definition.payload_model.model_validate(payload)
    except ValidationError as exc:
        raise InvalidPayload(type_id, [dict(e) for e in exc.errors()]) from None
    return model.model_dump(mode="json", exclude_none=True)


def attributes_for(type_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in get_object_type(type_id).attributes(payload).items() if v is not None}


def validate_relation(
    type_id: str,
    *,
    from_type: str,
    to_type: str,
    basis: RelationBasis | str,
    attributes: Any,
) -> dict[str, Any]:
    definition = get_relation_type(type_id)
    if from_type not in definition.from_types:
        raise AnalysisValidationError(f"{type_id} cannot start at a {from_type}")
    if to_type not in definition.to_types:
        raise AnalysisValidationError(f"{type_id} cannot end at a {to_type}")
    try:
        parsed_basis = RelationBasis(basis)
    except ValueError:
        raise AnalysisValidationError(f"{basis!r} is not a relation basis") from None
    if parsed_basis not in definition.bases:
        raise AnalysisValidationError(f"{type_id} cannot be recorded as {parsed_basis}")
    if definition.attributes_model is None:
        if attributes:
            raise AnalysisValidationError(f"{type_id} carries no attributes")
        return {}
    try:
        model = definition.attributes_model.model_validate(attributes or {})
    except ValidationError as exc:
        raise InvalidPayload(type_id, [dict(e) for e in exc.errors()]) from None
    return model.model_dump(mode="json", exclude_none=True)


def fact_check_eligible(type_id: str, payload: dict[str, Any], attributes: dict[str, Any]) -> bool:
    definition = get_object_type(type_id)
    return definition.fact_check is not None and definition.fact_check.eligible(payload, attributes)


# ── built-in types ──────────────────────────────────────────────────────


def _normalised(text: str) -> str:
    return " ".join(str(text or "").split())


def _argument_attributes(payload: dict[str, Any]) -> dict[str, Any]:
    return {"valence": payload.get("valence"), "epistemicKind": payload.get("epistemicKind")}


def _argument_detail(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statement": payload["statement"],
        "epistemicKind": payload["epistemicKind"],
        "valence": payload.get("valence"),
        "evidence": payload.get("evidence") or [],
    }


_ARGUMENT_MAP = MapCapability(
    label=lambda p: p["statement"],
    detail=_argument_detail,
    # Exactly Map's embedding input for a statement, so existing vectors in
    # map_embedding are reused rather than recomputed.
    embedding_text=lambda p: _normalised(p["statement"]),
    projection_version="statement-v1",
)

_CLAIM_CHECK = FactCheckCapability(
    eligible=lambda payload, attributes: (attributes.get("epistemicKind") or payload.get("epistemicKind"))
    == "claim",
    statement=lambda payload: payload["statement"],
)

ARGUMENT = ObjectType(
    id="argument",
    schema_version=1,
    payload_model=ArgumentPayload,
    attributes=_argument_attributes,
    map=_ARGUMENT_MAP,
    fact_check=_CLAIM_CHECK,
    description="A complete, source-grounded argument or claim from a transcript.",
)

DEDUPLICATED_ARGUMENT = ObjectType(
    id="deduplicated_argument",
    schema_version=1,
    payload_model=DeduplicatedArgumentPayload,
    attributes=_argument_attributes,
    map=MapCapability(
        label=lambda p: p["statement"],
        detail=lambda p: {**_argument_detail(p), "consolidation": p["consolidation"]},
        embedding_text=lambda p: _normalised(p["statement"]),
        projection_version="statement-v1",
    ),
    fact_check=_CLAIM_CHECK,
    description="An argument consolidating equivalent source arguments, derived from each.",
)

POPCORN = ObjectType(
    id="popcorn",
    schema_version=1,
    payload_model=PopcornPayload,
    map=MapCapability(
        label=lambda p: p["phrase"],
        detail=lambda p: {
            "phrase": p["phrase"],
            "question": p.get("question", False),
            "evidence": p.get("evidence") or [],
        },
        embedding_text=lambda p: _normalised(p["phrase"]),
        projection_version="phrase-v1",
    ),
    description="A short phrase from a conversation, as the Popcorn wall shows it.",
)

TENSION = ObjectType(
    id="tension",
    schema_version=1,
    payload_model=TensionPayload,
    map=MapCapability(
        label=lambda p: f"{p['poleA']} / {p['poleB']}",
        detail=lambda p: {
            "poleA": p["poleA"],
            "poleB": p["poleB"],
            "narrative": p["knot"],
            "toResolve": p["toResolve"],
            "quotes": p.get("quotes") or [],
        },
        embedding_text=lambda p: _normalised(
            f"{p['poleA']} versus {p['poleB']}. {p['knot']}"
        ),
        projection_version="poles-knot-v1",
    ),
    description="Two evidenced poles, the knot between them and the question to resolve.",
)

STAKEHOLDER = ObjectType(
    id="stakeholder",
    schema_version=1,
    payload_model=StakeholderPayload,
    map=MapCapability(
        label=lambda p: p["name"],
        detail=lambda p: {
            "name": p["name"],
            "role": p["role"],
            "stake": p["stake"],
            "rung": p["rung"],
            "invokedBy": p.get("invokedBy"),
            "weight": p["weight"],
            "quotes": p.get("quotes") or [],
        },
        embedding_text=lambda p: _normalised(f"{p['name']}: {p['role']}. {p['stake']}"),
        projection_version="name-role-stake-v1",
    ),
    description="A group with a stake, with how it is evidenced: voiced, named or inferred.",
)

FACT_CHECK_ASSESSMENT = ObjectType(
    id="fact_check_assessment",
    schema_version=1,
    payload_model=FactCheckAssessmentPayload,
    description="A completed fact-check of one exact claim revision, linked by `assesses`.",
)

_ARGUMENTS = frozenset({"argument", "deduplicated_argument"})
_MAP_TYPES = frozenset({"argument", "deduplicated_argument", "popcorn", "tension", "stakeholder"})
_ALL_BASES = frozenset(RelationBasis)

BUILTIN_OBJECT_TYPES = (
    ARGUMENT,
    DEDUPLICATED_ARGUMENT,
    POPCORN,
    TENSION,
    STAKEHOLDER,
    FACT_CHECK_ASSESSMENT,
)

BUILTIN_RELATION_TYPES = (
    RelationType(
        id="supports_pole_a",
        from_types=_ARGUMENTS,
        to_types=frozenset({"tension"}),
        bases=_ALL_BASES,
        attributes_model=EvidenceAttributes,
        description="An argument that establishes a tension's pole A.",
    ),
    RelationType(
        id="supports_pole_b",
        from_types=_ARGUMENTS,
        to_types=frozenset({"tension"}),
        bases=_ALL_BASES,
        attributes_model=EvidenceAttributes,
        description="An argument that establishes a tension's pole B.",
    ),
    RelationType(
        id="holds_position",
        from_types=frozenset({"stakeholder"}),
        to_types=_ARGUMENTS | {"tension"},
        bases=_ALL_BASES,
        attributes_model=EvidenceAttributes,
        description="A stakeholder evidenced as holding an argument or a tension's pole.",
    ),
    RelationType(
        id="affected_by",
        from_types=frozenset({"stakeholder"}),
        to_types=_ARGUMENTS | {"tension"},
        bases=_ALL_BASES,
        attributes_model=EvidenceAttributes,
        description="A stakeholder evidenced as affected by an argument or a tension.",
    ),
    RelationType(
        id="stakeholder_relation",
        from_types=frozenset({"stakeholder"}),
        to_types=frozenset({"stakeholder"}),
        bases=_ALL_BASES,
        attributes_model=StakeholderRelationAttributes,
        description="A relation between two stakeholders, with its label and aspects.",
    ),
    RelationType(
        id="derived_from",
        from_types=_MAP_TYPES,
        to_types=_MAP_TYPES,
        bases=_ALL_BASES,
        attributes_model=EvidenceAttributes,
        description="Explicit lineage: a consolidation, split or merge and its sources.",
    ),
    RelationType(
        id="assesses",
        from_types=frozenset({"fact_check_assessment"}),
        to_types=_ARGUMENTS,
        bases=frozenset({RelationBasis.EXTRACTED, RelationBasis.AUTHORED}),
        description="An assessment of one exact claim revision.",
    ),
)

BUILTIN_ATTRIBUTES = (
    AttributeDefinition(
        id="type",
        label="Type",
        applies_to=_MAP_TYPES,
        values=tuple(sorted(_MAP_TYPES)),
        missing="Unknown type",
    ),
    AttributeDefinition(
        id="valence",
        label="Valence",
        applies_to=_ARGUMENTS,
        values=("positive", "negative", "neutral"),
        missing="Not assessed",
        description="Missing valence is not neutral.",
    ),
    AttributeDefinition(
        id="factualStatus",
        label="Factual status",
        applies_to=_MAP_TYPES,
        values=("not_applicable", "unverified", "processing", "verdict", "error"),
        missing="not_applicable",
        description="Only fact-checkable revisions have a status; nothing inherits a connected claim's verdict.",
    ),
)


def _register_builtins() -> None:
    for object_type in BUILTIN_OBJECT_TYPES:
        register_object_type(object_type, replace=True)
    for relation_type in BUILTIN_RELATION_TYPES:
        register_relation_type(relation_type, replace=True)


_register_builtins()
