"""Deduplicated arguments: the recipe's pure core and its one model call.

Embedding similarity proposes candidates; it never establishes equivalence.

1. Candidate discovery (`emb-complete-linkage-v1`). Arguments with identical
   statement text, epistemic kind and valence form one exact unit. Units of the
   same kind and valence group by complete linkage on cosine similarity, with
   the embedding model's calibrated threshold: every pair inside a group
   reaches it, so a chain of small steps never joins two distant statements.
   A group larger than the maximum size is split deterministically, and at most
   a maximum number of groups is verified. Coverage records the strategy, its
   limits and whether they truncated discovery.
2. Verification. One model call per candidate group splits it into sub-groups,
   each with a proposed statement judged against every member.
3. Code, not the model, decides what merges: only an `equivalent` sub-group of
   two or more members, with one kind and one valence, a non-empty statement,
   and an `equivalent` judgement for each of its members, in an answer that
   accounts for every member of the group exactly once. Everything else stays
   separate. Identical exact units merge without a model call.

False merges are worse than missed duplicates, and there is no target
reduction: returning every input unchanged is a valid result. Every input
revision appears in exactly one output item.

Nothing here reads or writes a database. `deduplicate` takes the verifier as a
function, so the executor passes `verify_with_model` and tests pass a fake.
"""

from __future__ import annotations

import math
import asyncio
import hashlib
import logging
from typing import Any, Callable, Iterable, Sequence, Awaitable
from pathlib import Path
from functools import lru_cache
from dataclasses import field, asdict, dataclass

from dembrane.llms import MODELS, arouter_completion
from dembrane.map.model import usage_of, data_block, choice_text, json_from_text

logger = logging.getLogger("dembrane.analysis.recipes.deduplication")

RECIPE_ID = "deduplicated_arguments"
RECIPE_VERSION = "deduplicated-arguments-v1"
CANDIDATE_STRATEGY = "emb-complete-linkage-v1"
CANDIDATE_STRATEGY_VERSION = 1

# A prompt iteration is a new file and a new id, never an edit in place.
VERIFY_PROMPT = "dedup-verify-v1"
PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
MODEL_GROUP = MODELS.MULTI_MODAL_FAST

EPISTEMIC_KINDS = ("argument", "claim")
VALENCES = ("positive", "negative", "neutral")
VERDICTS = ("equivalent", "not_equivalent", "uncertain")

# Cosine similarity at or above which two units of the same kind and valence
# become candidates. A property of the embedding model, not of the data; the
# values are Map's consolidation calibration (text-embedding-004 on September
# 14th 2026: near-duplicates at 0.81 to 0.82, the median pair at 0.59). Here a
# threshold only proposes candidates for verification. An uncalibrated model
# finds identical statements only.
CANDIDATE_SIMILARITY_BY_MODEL: dict[str, float] = {
    "text-embedding-004": 0.80,
    "gemini-embedding-001": 0.92,
}

DEFAULT_MAX_GROUP_SIZE = 8
DEFAULT_MAX_CANDIDATE_GROUPS = 250
DEFAULT_CONCURRENCY = 4

# What the verifier sees of each member, beyond its statement.
MAX_QUOTES_SHOWN = 3
MAX_QUOTE_CHARS = 500

# Verification thinks (Gemini counts thinking against max_tokens), and one
# retry covers an answer that did not parse or a call that timed out.
VERIFY_MAX_TOKENS = 16_000
VERIFY_TIMEOUT_SECONDS = 180
VERIFY_ATTEMPTS = 2

_CHECK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["member", "judgement", "note"],
    "properties": {
        "member": {"type": "string"},
        "judgement": {"type": "string", "enum": list(VERDICTS)},
        "note": {"type": "string"},
    },
}

# Nested maxItems makes Vertex reject the whole schema, so sizes are checked
# in code.
RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["groups"],
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["members", "proposed_statement", "checks", "verdict", "rationale"],
                "properties": {
                    "members": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                    "proposed_statement": {"type": "string"},
                    "checks": {"type": "array", "items": _CHECK_SCHEMA},
                    "verdict": {"type": "string", "enum": list(VERDICTS)},
                    "rationale": {"type": "string"},
                },
            },
        }
    },
}


class InvalidInput(ValueError):
    pass


class MalformedAnswer(ValueError):
    pass


class AccountingError(AssertionError):
    """An output that does not hold every input revision exactly once."""


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").split())


def norm_key(text: str) -> str:
    return normalize_text(text).casefold()


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── input ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Evidence:
    conversation_id: str
    quote: str
    location: str | None = None


@dataclass(frozen=True)
class SourceArgument:
    """One pinned argument revision. `epistemic_kind` is `argument` or
    `claim`; `valence` is `positive`, `negative` or `neutral`."""

    revision_id: str
    object_id: str
    statement: str
    epistemic_kind: str
    valence: str
    evidence: list[Evidence]
    embedding: list[float]
    embedding_config_key: str


@dataclass(frozen=True)
class DeduplicationParams:
    """`embedding_model` selects the calibrated candidate threshold.
    `similarity_threshold` overrides it and is recorded as an override."""

    embedding_model: str
    similarity_threshold: float | None = None
    max_group_size: int = DEFAULT_MAX_GROUP_SIZE
    max_candidate_groups: int = DEFAULT_MAX_CANDIDATE_GROUPS
    concurrency: int = DEFAULT_CONCURRENCY

    def __post_init__(self) -> None:
        if self.similarity_threshold is not None and not (0 < self.similarity_threshold <= 1):
            raise InvalidInput("similarity_threshold must be in (0, 1]")
        if self.max_group_size < 2:
            raise InvalidInput("max_group_size must be at least 2")
        if self.max_candidate_groups < 0:
            raise InvalidInput("max_candidate_groups must not be negative")
        if self.concurrency < 1:
            raise InvalidInput("concurrency must be at least 1")


def candidate_threshold(params: DeduplicationParams) -> tuple[float | None, str]:
    """The threshold and where it came from: `override`, `calibrated` or
    `uncalibrated` (no threshold, identical statements only)."""
    if params.similarity_threshold is not None:
        return params.similarity_threshold, "override"
    name = params.embedding_model.rsplit("/", 1)[-1]
    threshold = CANDIDATE_SIMILARITY_BY_MODEL.get(name)
    return threshold, "calibrated" if threshold is not None else "uncalibrated"


def validate_arguments(arguments: Sequence[SourceArgument]) -> None:
    """Unique revisions with a statement, a known kind and valence, one
    embedding configuration and finite, nonzero vectors of one dimension."""
    seen: set[str] = set()
    config_key: str | None = None
    dims: int | None = None
    for argument in arguments:
        if not isinstance(argument, SourceArgument):
            raise InvalidInput("every input must be a SourceArgument")
        revision = argument.revision_id
        if not isinstance(revision, str) or not revision:
            raise InvalidInput("an argument has no revision id")
        if revision in seen:
            raise InvalidInput(f"revision {revision} appears more than once")
        seen.add(revision)
        if not argument.object_id:
            raise InvalidInput(f"revision {revision} has no object id")
        if not normalize_text(argument.statement):
            raise InvalidInput(f"revision {revision} has an empty statement")
        if argument.epistemic_kind not in EPISTEMIC_KINDS:
            raise InvalidInput(f"revision {revision} has an unknown epistemic kind")
        if argument.valence not in VALENCES:
            raise InvalidInput(f"revision {revision} has an unknown valence")
        if not all(isinstance(item, Evidence) for item in argument.evidence):
            raise InvalidInput(f"revision {revision} has evidence that is not Evidence")
        if not argument.embedding_config_key:
            raise InvalidInput(f"revision {revision} has no embedding configuration")
        if config_key is None:
            config_key = argument.embedding_config_key
        elif argument.embedding_config_key != config_key:
            raise InvalidInput("arguments must share one embedding configuration")
        vector = argument.embedding
        if not isinstance(vector, (list, tuple)) or not vector:
            raise InvalidInput(f"revision {revision} has no embedding")
        if dims is None:
            dims = len(vector)
        elif len(vector) != dims:
            raise InvalidInput(f"revision {revision} has {len(vector)} dimensions, expected {dims}")
        for value in vector:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise InvalidInput(f"revision {revision} has a non-numeric embedding value")
            if not math.isfinite(value):
                raise InvalidInput(f"revision {revision} has a non-finite embedding value")
        if not any(vector):
            raise InvalidInput(f"revision {revision} has the zero vector")


# ── candidate discovery ─────────────────────────────────────────────────


@dataclass(frozen=True)
class CandidateGroup:
    """Units proposed for verification. A unit is the revision ids of one
    statement stated identically; its first revision is what the verifier
    reads."""

    group_id: str
    epistemic_kind: str
    valence: str
    units: tuple[tuple[str, ...], ...]
    min_similarity: float

    @property
    def revision_ids(self) -> tuple[str, ...]:
        return tuple(revision for unit in self.units for revision in unit)


@dataclass(frozen=True)
class Coverage:
    """What candidate discovery examined. It never claims that every duplicate
    was found: embeddings propose, and `truncated` says whether a limit left
    candidate pairs uncompared."""

    strategy: str
    strategy_version: int
    embedding_model: str
    embedding_config_key: str | None
    threshold: float | None
    threshold_source: str
    semantic_discovery: bool
    max_group_size: int
    max_candidate_groups: int
    inputs: int
    exact_match_groups: int
    exact_match_members: int
    clusters_found: int
    clusters_split: int
    groups_found: int
    groups_considered: int
    groups_skipped: int
    members_covered: int
    members_skipped: int
    truncated: bool
    truncation_reasons: tuple[str, ...]


@dataclass(frozen=True)
class Discovery:
    units: tuple[tuple[str, ...], ...]
    groups: tuple[CandidateGroup, ...]
    skipped: tuple[CandidateGroup, ...]
    coverage: Coverage


def group_id_for(revision_ids: Iterable[str]) -> str:
    return "cg-" + _sha256_hex("\x1f".join(sorted(revision_ids)))[:16]


class _Linkage:
    def __init__(self, size: int) -> None:
        self.members: list[list[int]] = [[i] for i in range(size)]
        self.owner: list[int] = list(range(size))

    def join(self, a: int, b: int) -> None:
        keep, gone = sorted((self.owner[a], self.owner[b]))
        for member in self.members[gone]:
            self.owner[member] = keep
        self.members[keep].extend(self.members[gone])
        self.members[gone] = []


def _complete_linkage(similarity: Any, threshold: float) -> list[list[int]]:
    """Clusters in which every pair reaches the threshold, joined from the most
    similar pair down, ties broken by position."""
    import numpy as np

    count = similarity.shape[0]
    linkage = _Linkage(count)
    close = np.triu(similarity >= threshold, k=1)
    rows, cols = np.nonzero(close)
    pairs = sorted(
        zip(rows.tolist(), cols.tolist(), strict=True),
        key=lambda pair: (-float(similarity[pair[0], pair[1]]), pair[0], pair[1]),
    )
    for i, j in pairs:
        gi, gj = linkage.owner[i], linkage.owner[j]
        if gi == gj:
            continue
        block = similarity[np.ix_(linkage.members[gi], linkage.members[gj])]
        if bool(np.all(block >= threshold)):
            linkage.join(i, j)
    return [sorted(members) for members in linkage.members if members]


def _split_cluster(cluster: list[int], similarity: Any, max_size: int) -> list[list[int]]:
    """Chunks of at most `max_size`: seed each with the earliest remaining
    member and add the member whose lowest similarity to the chunk is highest,
    earliest on a tie."""
    if len(cluster) <= max_size:
        return [sorted(cluster)]
    remaining = sorted(cluster)
    chunks: list[list[int]] = []
    while remaining:
        chunk = [remaining.pop(0)]
        while remaining and len(chunk) < max_size:
            best = max(
                remaining,
                key=lambda j: (min(float(similarity[j, k]) for k in chunk), -j),
            )
            chunk.append(best)
            remaining.remove(best)
        chunks.append(sorted(chunk))
    return chunks


def discover_candidates(
    arguments: Sequence[SourceArgument], params: DeduplicationParams
) -> Discovery:
    """Exact units and candidate groups, without any model call."""
    import numpy as np

    validate_arguments(arguments)
    threshold, threshold_source = candidate_threshold(params)

    by_key: dict[tuple[str, str, str], list[int]] = {}
    for index, argument in enumerate(arguments):
        key = (argument.epistemic_kind, argument.valence, norm_key(argument.statement))
        by_key.setdefault(key, []).append(index)
    unit_indices = sorted(by_key.values(), key=lambda unit: unit[0])
    units = tuple(tuple(arguments[i].revision_id for i in unit) for unit in unit_indices)

    partitions: dict[tuple[str, str], list[int]] = {}
    for position, unit in enumerate(unit_indices):
        head = arguments[unit[0]]
        partitions.setdefault((head.epistemic_kind, head.valence), []).append(position)

    found: list[tuple[int, CandidateGroup]] = []
    clusters_found = 0
    clusters_split = 0
    if threshold is not None:
        for kind, valence in sorted(partitions):
            positions = partitions[(kind, valence)]
            if len(positions) < 2:
                continue
            matrix = np.array(
                [arguments[unit_indices[p][0]].embedding for p in positions], dtype=np.float64
            )
            unit_vectors = matrix / np.linalg.norm(matrix, axis=1)[:, None]
            similarity = unit_vectors @ unit_vectors.T
            for cluster in _complete_linkage(similarity, threshold):
                if len(cluster) < 2:
                    continue
                clusters_found += 1
                chunks = _split_cluster(cluster, similarity, params.max_group_size)
                if len(chunks) > 1:
                    clusters_split += 1
                for chunk in chunks:
                    if len(chunk) < 2:
                        continue
                    lowest = min(float(similarity[a, b]) for a in chunk for b in chunk if a < b)
                    group_units = tuple(units[positions[local]] for local in chunk)
                    group = CandidateGroup(
                        group_id=group_id_for(r for unit in group_units for r in unit),
                        epistemic_kind=kind,
                        valence=valence,
                        units=group_units,
                        min_similarity=round(lowest, 6),
                    )
                    found.append((unit_indices[positions[chunk[0]]][0], group))

    # The likeliest duplicates are verified first when the group limit binds.
    found.sort(key=lambda item: (-item[1].min_similarity, item[0]))
    ordered = [group for _, group in found]
    considered = tuple(ordered[: params.max_candidate_groups])
    skipped = tuple(ordered[params.max_candidate_groups :])

    exact = [unit for unit in units if len(unit) > 1]
    exact_members = {revision for unit in exact for revision in unit}
    considered_members = {revision for group in considered for revision in group.revision_ids}
    skipped_members = {revision for group in skipped for revision in group.revision_ids}
    reasons: list[str] = []
    if clusters_split:
        reasons.append("max_group_size")
    if skipped:
        reasons.append("max_candidate_groups")
    config_key = arguments[0].embedding_config_key if arguments else None
    coverage = Coverage(
        strategy=CANDIDATE_STRATEGY,
        strategy_version=CANDIDATE_STRATEGY_VERSION,
        embedding_model=params.embedding_model,
        embedding_config_key=config_key,
        threshold=threshold,
        threshold_source=threshold_source,
        semantic_discovery=threshold is not None,
        max_group_size=params.max_group_size,
        max_candidate_groups=params.max_candidate_groups,
        inputs=len(arguments),
        exact_match_groups=len(exact),
        exact_match_members=len(exact_members),
        clusters_found=clusters_found,
        clusters_split=clusters_split,
        groups_found=len(ordered),
        groups_considered=len(considered),
        groups_skipped=len(skipped),
        members_covered=len(considered_members | exact_members),
        members_skipped=len(skipped_members - exact_members),
        truncated=bool(reasons),
        truncation_reasons=tuple(reasons),
    )
    return Discovery(units=units, groups=considered, skipped=skipped, coverage=coverage)


# ── verification ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VerificationMember:
    label: str
    revision_ids: tuple[str, ...]
    epistemic_kind: str
    valence: str
    statement: str
    quotes: tuple[str, ...]


@dataclass(frozen=True)
class VerificationRequest:
    """What one verification call reads. Members carry short labels (`m1`,
    `m2`, ...); the model never sees or returns a database id."""

    group_id: str
    members: tuple[VerificationMember, ...]

    def revision_ids_for(self, label: str) -> tuple[str, ...]:
        for member in self.members:
            if member.label == label:
                return member.revision_ids
        raise KeyError(label)


Verifier = Callable[[VerificationRequest], Awaitable[tuple[Any, dict[str, int]]]]


def build_request(
    group: CandidateGroup, arguments_by_revision: dict[str, SourceArgument]
) -> VerificationRequest:
    members = []
    for position, unit in enumerate(group.units, start=1):
        head = arguments_by_revision[unit[0]]
        quotes: list[str] = []
        known: set[str] = set()
        for revision in unit:
            for item in arguments_by_revision[revision].evidence:
                quote = normalize_text(item.quote)[:MAX_QUOTE_CHARS]
                if quote and quote.casefold() not in known and len(quotes) < MAX_QUOTES_SHOWN:
                    known.add(quote.casefold())
                    quotes.append(quote)
        members.append(
            VerificationMember(
                label=f"m{position}",
                revision_ids=unit,
                epistemic_kind=head.epistemic_kind,
                valence=head.valence,
                statement=normalize_text(head.statement),
                quotes=tuple(quotes),
            )
        )
    return VerificationRequest(group_id=group.group_id, members=tuple(members))


def verification_user_text(request: VerificationRequest) -> str:
    """The user message. Statements and quotes are whitespace-normalised onto
    one line each, so no text can start a line that looks like another member,
    and they reach the model only inside the ARGUMENTS block."""
    lines: list[str] = []
    for member in request.members:
        lines.append(member.label)
        lines.append(f"kind: {member.epistemic_kind}")
        lines.append(f"valence: {member.valence}")
        lines.append(f"statement: {member.statement}")
        lines.append("quotes:")
        lines.extend(f'- "{quote}"' for quote in member.quotes)
        lines.append("")
    labels = ", ".join(member.label for member in request.members)
    return "\n\n".join(
        [
            f"A candidate group of {len(request.members)} members: {labels}.",
            data_block("ARGUMENTS", "\n".join(lines).strip()),
            "Split the members into sub-groups, account for every member exactly once, "
            "and check each proposed statement against every member of its sub-group.",
        ]
    )


@dataclass(frozen=True)
class MemberCheck:
    label: str
    revision_ids: tuple[str, ...]
    judgement: str
    note: str


@dataclass(frozen=True)
class SubGroupOutcome:
    """One sub-group of the answer and what code decided about it. `outcome`
    is `merged`, `single_member`, `mixed_attributes`, `not_equivalent`,
    `uncertain`, `empty_statement`, `checks_incomplete` or
    `member_not_equivalent`."""

    labels: tuple[str, ...]
    revision_ids: tuple[str, ...]
    verdict: str
    proposed_statement: str
    rationale: str
    checks: tuple[MemberCheck, ...]
    merged: bool
    outcome: str


@dataclass(frozen=True)
class GroupCheck:
    """One candidate group's verification. `status` is `verified` (the answer
    was well formed; see its sub-groups), `malformed` or `call_failed`; the
    last two keep every member separate."""

    group_id: str
    revision_ids: tuple[str, ...]
    min_similarity: float
    status: str
    error: str | None
    sub_groups: tuple[SubGroupOutcome, ...]
    usage: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class _RawSubGroup:
    labels: tuple[str, ...]
    statement: str
    verdict: str
    rationale: str
    checks: tuple[tuple[str, str, str], ...]


def _parse_answer(raw: Any, labels: tuple[str, ...]) -> list[_RawSubGroup]:
    if not isinstance(raw, dict):
        raise MalformedAnswer("the answer is not a JSON object")
    groups = raw.get("groups")
    if not isinstance(groups, list) or not groups:
        raise MalformedAnswer("the answer has no groups")
    known = set(labels)
    seen: set[str] = set()
    parsed: list[_RawSubGroup] = []
    for position, value in enumerate(groups):
        where = f"sub-group {position + 1}"
        if not isinstance(value, dict):
            raise MalformedAnswer(f"{where} is not an object")
        members = value.get("members")
        if not isinstance(members, list) or not members:
            raise MalformedAnswer(f"{where} has no members")
        for label in members:
            if not isinstance(label, str) or label not in known:
                raise MalformedAnswer(f"{where} names an unknown member {label!r}")
            if label in seen:
                raise MalformedAnswer(f"member {label} appears more than once")
            seen.add(label)
        statement = value.get("proposed_statement")
        verdict = value.get("verdict")
        rationale = value.get("rationale")
        checks = value.get("checks")
        if not isinstance(statement, str):
            raise MalformedAnswer(f"{where} has no proposed statement")
        if verdict not in VERDICTS:
            raise MalformedAnswer(f"{where} has an unknown verdict {verdict!r}")
        if not isinstance(rationale, str):
            raise MalformedAnswer(f"{where} has no rationale")
        if not isinstance(checks, list):
            raise MalformedAnswer(f"{where} has no checks")
        shaped: list[tuple[str, str, str]] = []
        for check in checks:
            if (
                not isinstance(check, dict)
                or not isinstance(check.get("member"), str)
                or check.get("judgement") not in VERDICTS
                or not isinstance(check.get("note"), str)
            ):
                raise MalformedAnswer(f"{where} has a malformed check")
            shaped.append((check["member"], check["judgement"], check["note"]))
        parsed.append(
            _RawSubGroup(
                labels=tuple(members),
                statement=statement,
                verdict=str(verdict),
                rationale=rationale,
                checks=tuple(shaped),
            )
        )
    missing = [label for label in labels if label not in seen]
    if missing:
        raise MalformedAnswer(f"members not accounted for: {', '.join(missing)}")
    return parsed


def _judge(
    sub: _RawSubGroup,
    request: VerificationRequest,
    arguments_by_revision: dict[str, SourceArgument],
) -> SubGroupOutcome:
    labels = set(sub.labels)
    revision_ids = tuple(r for label in sub.labels for r in request.revision_ids_for(label))
    checks = tuple(
        MemberCheck(
            label=label,
            revision_ids=request.revision_ids_for(label) if label in labels else (),
            judgement=judgement,
            note=normalize_text(note),
        )
        for label, judgement, note in sub.checks
    )
    checked = [check.label for check in checks]
    attributes = {
        (arguments_by_revision[r].epistemic_kind, arguments_by_revision[r].valence)
        for r in revision_ids
    }
    if len(sub.labels) < 2:
        outcome = "single_member"
    elif len(attributes) > 1:
        outcome = "mixed_attributes"
    elif sub.verdict != "equivalent":
        outcome = sub.verdict
    elif not normalize_text(sub.statement):
        outcome = "empty_statement"
    elif len(checked) != len(set(checked)) or set(checked) != labels:
        outcome = "checks_incomplete"
    elif any(check.judgement != "equivalent" for check in checks):
        outcome = "member_not_equivalent"
    else:
        outcome = "merged"
    return SubGroupOutcome(
        labels=sub.labels,
        revision_ids=revision_ids,
        verdict=sub.verdict,
        proposed_statement=normalize_text(sub.statement),
        rationale=normalize_text(sub.rationale),
        checks=checks,
        merged=outcome == "merged",
        outcome=outcome,
    )


def check_answer(
    group: CandidateGroup,
    request: VerificationRequest,
    arguments_by_revision: dict[str, SourceArgument],
    raw: Any,
    usage: dict[str, int] | None = None,
) -> GroupCheck:
    """Apply the merge rules to one verifier answer."""
    labels = tuple(member.label for member in request.members)
    try:
        subs = _parse_answer(raw, labels)
    except MalformedAnswer as exc:
        return GroupCheck(
            group_id=group.group_id,
            revision_ids=group.revision_ids,
            min_similarity=group.min_similarity,
            status="malformed",
            error=str(exc),
            sub_groups=(),
            usage=dict(usage or {}),
        )
    return GroupCheck(
        group_id=group.group_id,
        revision_ids=group.revision_ids,
        min_similarity=group.min_similarity,
        status="verified",
        error=None,
        sub_groups=tuple(_judge(sub, request, arguments_by_revision) for sub in subs),
        usage=dict(usage or {}),
    )


# ── output ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Verification:
    """Why an item looks the way it does. `method` is `model`, `exact_match`
    or `none`. `outcome` is a sub-group outcome, `exact_match`, `malformed`,
    `call_failed`, `candidate_limit` (a candidate group left unverified by the
    group limit) or `no_candidate`."""

    method: str
    outcome: str
    verdict: str | None
    rationale: str
    group_id: str | None
    checks: tuple[MemberCheck, ...] = ()


@dataclass(frozen=True)
class DeduplicatedItem:
    """One output argument. `support_count` counts source arguments, not
    participants or conversations. `statement_revision_id` names the member
    whose statement is this exact text, when one is, so its vector can be
    reused."""

    statement: str
    epistemic_kind: str
    valence: str
    member_revision_ids: tuple[str, ...]
    member_object_ids: tuple[str, ...]
    evidence: tuple[Evidence, ...]
    support_count: int
    statement_revision_id: str | None
    verification: Verification


@dataclass(frozen=True)
class Usage:
    calls: int
    failed_calls: int
    malformed_answers: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    model_attempts: int


@dataclass(frozen=True)
class DeduplicationResult:
    recipe_id: str
    recipe_version: str
    prompt_id: str
    consolidated: tuple[DeduplicatedItem, ...]
    singletons: tuple[DeduplicatedItem, ...]
    checks: tuple[GroupCheck, ...]
    coverage: Coverage
    usage: Usage

    @property
    def items(self) -> tuple[DeduplicatedItem, ...]:
        return self.consolidated + self.singletons

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _item(
    revisions: list[str],
    arguments_by_revision: dict[str, SourceArgument],
    statement: str,
    verification: Verification,
) -> DeduplicatedItem:
    members = [arguments_by_revision[r] for r in revisions]
    evidence: list[Evidence] = []
    known: set[tuple[str, str]] = set()
    for member in members:
        for item in member.evidence:
            key = (item.conversation_id, norm_key(item.quote))
            if key not in known:
                known.add(key)
                evidence.append(item)
    same_text = next(
        (m.revision_id for m in members if norm_key(m.statement) == norm_key(statement)), None
    )
    return DeduplicatedItem(
        statement=statement,
        epistemic_kind=members[0].epistemic_kind,
        valence=members[0].valence,
        member_revision_ids=tuple(revisions),
        member_object_ids=tuple(m.object_id for m in members),
        evidence=tuple(evidence),
        support_count=len(members),
        statement_revision_id=same_text,
        verification=verification,
    )


def account_for(arguments: Sequence[SourceArgument], items: Iterable[DeduplicatedItem]) -> None:
    """Raise unless every input revision is in exactly one item and no item
    holds anything else."""
    expected = [a.revision_id for a in arguments]
    produced = [r for item in items for r in item.member_revision_ids]
    if sorted(produced) != sorted(expected):
        missing = set(expected) - set(produced)
        extra = set(produced) - set(expected)
        repeated = {r for r in produced if produced.count(r) > 1}
        raise AccountingError(
            f"output does not account for its inputs: missing {sorted(missing)}, "
            f"unknown {sorted(extra)}, repeated {sorted(repeated)}"
        )


def assemble_result(
    arguments: Sequence[SourceArgument],
    discovery: Discovery,
    checks: Sequence[GroupCheck],
) -> DeduplicationResult:
    """Merged sub-groups, exact units and pass-through singletons, with every
    input revision in exactly one of them."""
    by_revision = {a.revision_id: a for a in arguments}
    position = {a.revision_id: index for index, a in enumerate(arguments)}
    context: dict[str, tuple[GroupCheck, SubGroupOutcome | None]] = {}
    consolidated: list[DeduplicatedItem] = []
    claimed: set[str] = set()
    for check in checks:
        for revision in check.revision_ids:
            context[revision] = (check, None)
        for sub in check.sub_groups:
            for revision in sub.revision_ids:
                context[revision] = (check, sub)
            if not sub.merged:
                continue
            revisions = sorted(sub.revision_ids, key=position.__getitem__)
            claimed.update(revisions)
            consolidated.append(
                _item(
                    revisions,
                    by_revision,
                    sub.proposed_statement,
                    Verification(
                        method="model",
                        outcome="merged",
                        verdict=sub.verdict,
                        rationale=sub.rationale,
                        group_id=check.group_id,
                        checks=sub.checks,
                    ),
                )
            )
    skipped = {revision for group in discovery.skipped for revision in group.revision_ids}
    singletons: list[DeduplicatedItem] = []
    for unit in discovery.units:
        if unit[0] in claimed:
            continue
        head = by_revision[unit[0]]
        if len(unit) > 1:
            consolidated.append(
                _item(
                    list(unit),
                    by_revision,
                    normalize_text(head.statement),
                    Verification(
                        method="exact_match",
                        outcome="exact_match",
                        verdict="equivalent",
                        rationale="Identical statement text, epistemic kind and valence.",
                        group_id=None,
                    ),
                )
            )
            continue
        found = context.get(unit[0])
        if found is not None and found[1] is not None:
            check, sub = found[0], found[1]
            verification = Verification(
                method="model",
                outcome=sub.outcome,
                verdict=sub.verdict,
                rationale=sub.rationale,
                group_id=check.group_id,
                checks=sub.checks,
            )
        elif found is not None:
            verification = Verification(
                method="model",
                outcome=found[0].status,
                verdict=None,
                rationale=found[0].error or "",
                group_id=found[0].group_id,
            )
        elif unit[0] in skipped:
            verification = Verification(
                method="none", outcome="candidate_limit", verdict=None, rationale="", group_id=None
            )
        else:
            verification = Verification(
                method="none", outcome="no_candidate", verdict=None, rationale="", group_id=None
            )
        singletons.append(_item([unit[0]], by_revision, head.statement, verification))

    consolidated.sort(key=lambda item: min(position[r] for r in item.member_revision_ids))
    singletons.sort(key=lambda item: position[item.member_revision_ids[0]])
    account_for(arguments, [*consolidated, *singletons])

    def total(name: str) -> int:
        return sum(int(check.usage.get(name, 0)) for check in checks)

    return DeduplicationResult(
        recipe_id=RECIPE_ID,
        recipe_version=RECIPE_VERSION,
        prompt_id=VERIFY_PROMPT,
        consolidated=tuple(consolidated),
        singletons=tuple(singletons),
        checks=tuple(checks),
        coverage=discovery.coverage,
        usage=Usage(
            calls=len(checks),
            failed_calls=sum(1 for check in checks if check.status == "call_failed"),
            malformed_answers=sum(1 for check in checks if check.status == "malformed"),
            prompt_tokens=total("prompt_tokens"),
            completion_tokens=total("completion_tokens"),
            total_tokens=total("total_tokens"),
            model_attempts=total("attempts"),
        ),
    )


async def deduplicate(
    arguments: Sequence[SourceArgument],
    params: DeduplicationParams,
    verifier: Verifier,
) -> DeduplicationResult:
    """Discover candidates, verify each group with `verifier`, apply the merge
    rules and account for every input. A verifier that raises keeps its group
    separate and is recorded; cancellation propagates."""
    discovery = discover_candidates(arguments, params)
    by_revision = {a.revision_id: a for a in arguments}
    semaphore = asyncio.Semaphore(params.concurrency)

    async def verify(group: CandidateGroup) -> GroupCheck:
        request = build_request(group, by_revision)
        async with semaphore:
            try:
                raw, usage = await verifier(request)
            except Exception as exc:
                logger.warning("deduplication verification failed for %s: %s", group.group_id, exc)
                return GroupCheck(
                    group_id=group.group_id,
                    revision_ids=group.revision_ids,
                    min_similarity=group.min_similarity,
                    status="call_failed",
                    error=f"{type(exc).__name__}: {exc}",
                    sub_groups=(),
                )
        return check_answer(group, request, by_revision, raw, usage)

    checks = await asyncio.gather(*(verify(group) for group in discovery.groups))
    return assemble_result(arguments, discovery, checks)


# ── model call ──────────────────────────────────────────────────────────


@lru_cache(maxsize=4)
def prompt_text(name: str = VERIFY_PROMPT) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")


def prompt_fingerprint(name: str = VERIFY_PROMPT) -> str:
    """The exact prompt text a cache key or step artifact can name."""
    return _sha256_hex(prompt_text(name))


async def verify_with_model(request: VerificationRequest) -> tuple[dict[str, Any], dict[str, int]]:
    """One verification call for one candidate group.

    Returns the parsed answer and the token usage summed over attempts, with
    `attempts`. Retries once on a timeout or an answer that does not parse;
    the rules in `check_answer` judge the answer's content."""
    user_text = verification_user_text(request)
    usage: dict[str, int] = {"attempts": 0}
    last_error: Exception | None = None
    for attempt in range(1, VERIFY_ATTEMPTS + 1):
        usage["attempts"] = attempt
        try:
            response = await asyncio.wait_for(
                arouter_completion(
                    MODEL_GROUP,
                    messages=[
                        {"role": "system", "content": prompt_text(VERIFY_PROMPT)},
                        {"role": "user", "content": user_text},
                    ],
                    temperature=0,
                    max_tokens=VERIFY_MAX_TOKENS,
                    response_format={"type": "json_object", "response_schema": RESPONSE_SCHEMA},
                ),
                timeout=VERIFY_TIMEOUT_SECONDS,
            )
            for name, value in usage_of(response).items():
                usage[name] = usage.get(name, 0) + value
            text = choice_text(response)
            return json_from_text(text), usage
        except (ValueError, TimeoutError, asyncio.TimeoutError) as exc:
            last_error = exc
            logger.warning(
                "deduplication verification attempt %d/%d failed for %s: %s",
                attempt,
                VERIFY_ATTEMPTS,
                request.group_id,
                exc,
            )
            if attempt < VERIFY_ATTEMPTS:
                await asyncio.sleep(2 * attempt)
    assert last_error is not None
    raise last_error
