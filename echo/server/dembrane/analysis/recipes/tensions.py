"""Tensions from saved arguments.

The popcorn tick finds tensions by reading every transcript for positions
first. This recipe starts from pinned argument revisions instead (raw or
deduplicated, never both) and runs its own stages over them, reusing
popcorn's framing and dedupe stages from `dembrane.popcorn.tensions`:

0. positions   no model call: every argument revision is one position, its
               holder named after its conversations, its kind its epistemic
               kind, hedged when its statement hedges, its quotes its evidence
               grounded in the source passages the way Map grounds them
               (verbatim over collapsed whitespace and case, or ordered
               fragments around an ellipsis)
1. framing     what the rooms were handed, when full transcripts are at hand
2. collisions  several focal positions per call against the listing of all of
               them; each collision names the question both sides answer
3. verify      one call per candidate pair with the pair's source passages:
               one question, opposite answers, both held. A rejected pair keeps
               its reason. The verifier names the poles; it never supplies a
               side or a quote
4. dedupe      one call per verified pair against the tensions kept; a facet
               proposes its arguments for the pole its quotes went to
5. support     one call per kept tension: which of its proposed arguments
               support pole A, pole B or neither. Only confirmed arguments hold
               a pole, strongest first and at most three per pole; every
               argument is judged once per tension, so never on both poles of
               one, and again for every other tension it is proposed for
6. write       the knot and the question, with popcorn's screen gate and a
               completeness gate (a finished sentence, no ellipsis, no elided
               clause), and one retry; the host note on voice reaches this
               stage only. Flags left after the retry stay on the tension

Evidence is the contract. A tension leaves this module only with at least one
confirmed argument revision on each pole whose evidence was found in its
source, and every such argument becomes a `supports_pole_a` or
`supports_pole_b` relation carrying the checks that established it. Zero
tensions is a result. Too little evidence to look for tensions is a result
too: it says so and suggests refreshing the arguments, without a model call.

`run_tensions` is pipeline logic and model calls only. The recipe at the end
of this module runs it through the executor: every judgement becomes a cached
model step of its stage, the positions and the review are recorded as checks,
and tensions, their embeddings and their relations are emitted against the
exact pinned argument revisions.
"""

from __future__ import annotations

import re
import time
import asyncio
import hashlib
import contextlib
import contextvars
from typing import Any, Literal, Mapping, Iterable, Sequence, Coroutine
from pathlib import Path
from collections import Counter, defaultdict
from dataclasses import field, asdict, replace, dataclass

from pydantic import BaseModel, ConfigDict

from dembrane.popcorn import tensions as stages
from dembrane.analysis import types
from dembrane.map.model import data_block
from dembrane.map.recipe import norm_key, ground_quote
from dembrane.popcorn.gates import screen_flags
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import StepResult, RecipeFailed, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, Dependency, InputRequest, IdentityPolicy
from dembrane.analysis.contracts import (
    StepKind,
    SourceRef,
    CheckStatus,
    CheckOutcome,
    ObjectRevision,
)
from dembrane.analysis.embeddings import EmbeddingRef, EmbeddingService, input_hash
from dembrane.analysis.recipes.services import model_deployment, producer_services
from dembrane.analysis.recipes.arguments import (
    fresh,
    artifact_hash,
    argument_order,
    revision_quotes,
    live_model_deployment,
    load_pinned_transcripts,
)

RECIPE_ID = "tensions"
RECIPE_VERSION = "tensions-from-arguments-v2"

POPCORN_PROMPTS = Path(stages.__file__).with_name("prompts")
RECIPE_PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
# Each stage's prompt file. A prompt iteration is a new file, never an edit in
# place. The dedupe prompt lives inline in popcorn's stages and is identified
# by its content hash.
PROMPT_FILES: dict[str, tuple[Path, str]] = {
    "handed": (POPCORN_PROMPTS, "tensions-handed"),
    "collisions": (RECIPE_PROMPTS, "tensions-collisions-v1"),
    "verify": (RECIPE_PROMPTS, "tensions-verify-v1"),
    "support": (RECIPE_PROMPTS, "tensions-support-v1"),
    "write": (RECIPE_PROMPTS, "tensions-write-v1"),
}
PROMPT_NAMES = tuple(PROMPT_FILES)
DEDUPE_PROMPT_NAME = "dedupe"

# Tensions pull between conversations; one conversation's evidence is not
# enough to look for them.
MIN_CONVERSATIONS = 2
# The positions cap and its fairness are popcorn's; whatever it leaves out is
# reported.
MAX_POSITIONS = stages.MAX_POSITIONS_TOTAL
# Focal positions judged in one collisions call, against the whole listing.
FOCAL_BATCH = 10
# Candidate pairs verified, and how many of them one argument may take part in,
# so one loud argument cannot fill the verification budget.
MAX_CANDIDATES = 24
MAX_PAIRS_PER_POSITION = 4
MAX_TENSIONS = stages.MAX_TENSIONS
MAX_SUPPORTERS_PER_POLE = 3
# Below this the support check's own scale means "neither".
MIN_SUPPORT_STRENGTH = 0.5
QUOTES_PER_POLE = 2

NOT_ASSESSED = (
    "- not assessed for this run: only passages around the evidence were available, "
    "so what the rooms were handed is unknown"
)
SUGGEST_REFRESH = "refresh_arguments"

HEDGED = re.compile(
    r"\b(maybe|perhaps|possibly|i wonder|wondering|not sure|just an idea|i guess|might be)\b",
    re.IGNORECASE,
)

InputSet = Literal["raw", "deduplicated"]
ArgumentType = Literal["argument", "deduplicated_argument"]
EpistemicKind = Literal["argument", "claim"]
RelationType = Literal["supports_pole_a", "supports_pole_b"]
RELATION_BY_POLE: dict[str, RelationType] = {"A": "supports_pole_a", "B": "supports_pole_b"}

# Nested maxItems makes Vertex reject a whole schema, so sizes are checked in code.
COLLISIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["collisions"],
    "properties": {
        "collisions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["focal", "other", "question", "why", "zero_sum"],
                "properties": {
                    "focal": {"type": "string", "maxLength": 12},
                    "other": {"type": "string", "maxLength": 12},
                    "question": {"type": "string", "maxLength": 160},
                    "why": {"type": "string", "maxLength": 240},
                    "zero_sum": {"type": "number", "minimum": 0, "maximum": 1},
                },
            },
        }
    },
}
VERIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["valid", "opposed", "question", "reason", "poleA", "poleB"],
    "properties": {
        "valid": {"type": "boolean"},
        "opposed": {"type": "boolean"},
        "question": {"type": "string", "maxLength": 160},
        "reason": {"type": "string", "maxLength": 300},
        "poleA": {"type": "string", "maxLength": 60},
        "poleB": {"type": "string", "maxLength": 60},
    },
}
SUPPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["supporters"],
    "properties": {
        "supporters": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "pole", "strength", "why"],
                "properties": {
                    "id": {"type": "string", "maxLength": 12},
                    "pole": {"type": "string", "enum": ["A", "B", "neither"]},
                    "strength": {"type": "number", "minimum": 0, "maximum": 1},
                    "why": {"type": "string", "maxLength": 200},
                },
            },
        }
    },
}
# The deck's written shape, as popcorn writes it; its own object, so the
# recipe can tell its write calls from popcorn's.
WRITE_SCHEMA: dict[str, Any] = {**stages.WRITE_SCHEMA}


@dataclass(frozen=True)
class Evidence:
    conversation_id: str
    quote: str
    location: Any = None


@dataclass(frozen=True)
class ArgumentRevision:
    """One pinned argument revision. A deduplicated argument names its member
    revisions; their evidence counts as its own when the members are passed
    alongside."""

    revision_id: str
    object_id: str
    type: ArgumentType
    statement: str
    epistemic_kind: EpistemicKind
    valence: str | None = None
    evidence: Sequence[Evidence] = ()
    member_revision_ids: Sequence[str] = ()


@dataclass(frozen=True)
class SourcePassages:
    """What one conversation offers verification: its transcript, or the
    passage windows around its quotes. The label names the conversation in
    prompts ("Table 3"), so it must not be a participant's name."""

    conversation_id: str
    label: str
    transcript: str | None = None
    passages: Sequence[str] = ()

    @property
    def text(self) -> str:
        if self.transcript:
            return self.transcript
        return "\n[...]\n".join(p for p in self.passages if p)

    @property
    def full(self) -> bool:
        return bool(self.transcript)


@dataclass(frozen=True)
class QuoteRef:
    id: str
    conversation_id: str
    text: str
    location: Any = None


@dataclass(frozen=True)
class PoleSupporter:
    revision_id: str
    object_id: str
    member_revision_ids: list[str]
    quote_ids: list[str]
    strength: float = 0.0
    why: str = ""


@dataclass(frozen=True)
class SupportRelation:
    type: RelationType
    from_revision_id: str
    to_tension: str  # the tension's key in this result; the executor assigns its revision
    basis: Literal["extracted"]
    check: dict[str, Any]


@dataclass(frozen=True)
class Tension:
    key: str
    pole_a: str
    pole_b: str
    knot: str
    to_resolve: str
    quote_ids: list[str]
    quotes: list[QuoteRef]
    supporters_a: list[PoleSupporter]
    supporters_b: list[PoleSupporter]
    screen_flags: list[str]
    question: str = ""

    def payload(self) -> dict[str, Any]:
        """The deck's tension shape with its quote references."""
        return {
            "poleA": self.pole_a,
            "poleB": self.pole_b,
            "knot": self.knot,
            "toResolve": self.to_resolve,
            "quoteIds": list(self.quote_ids),
            "quotes": [asdict(q) for q in self.quotes],
        }


@dataclass
class Coverage:
    arguments: int = 0
    positions: int = 0
    conversations: int = 0
    conversations_with_evidence: int = 0
    without_evidence: list[str] = field(default_factory=list)
    without_source: list[str] = field(default_factory=list)
    evidence_not_found: list[str] = field(default_factory=list)
    trimmed: list[str] = field(default_factory=list)
    members_missing: dict[str, list[str]] = field(default_factory=dict)
    # Facets that would have put an argument already holding one pole on the other.
    both_poles_skipped: list[str] = field(default_factory=list)
    # Verified pairs that are not tensions, each with the verifier's reason.
    rejected_pairs: list[dict[str, Any]] = field(default_factory=list)
    # Kept tensions the support check left without a pole, with why.
    unsupported: list[dict[str, Any]] = field(default_factory=list)
    support_rejected: int = 0
    support_capped: int = 0
    framing: Literal["assessed", "not_assessed"] = "not_assessed"
    thin: bool = False
    note: str | None = None


@dataclass
class TensionsResult:
    status: Literal["ok", "insufficient_coverage"]
    input_set: InputSet
    input_revision_ids: list[str]
    tensions: list[Tension]
    relations: list[SupportRelation]
    quotes: list[QuoteRef]
    coverage: Coverage
    counts: dict[str, int]
    usage: dict[str, Any]
    prompt_versions: dict[str, str]
    gate_flags: list[str] = field(default_factory=list)
    suggestion: str | None = None
    recipe_id: str = RECIPE_ID
    recipe_version: str = RECIPE_VERSION

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_prompts() -> dict[str, str]:
    """Every stage's prompt file, read without importing the model client."""
    return {name: (folder / f"{file}.md").read_text(encoding="utf-8") for name, (folder, file) in PROMPT_FILES.items()}


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def prompt_versions(prompts: Mapping[str, str]) -> dict[str, str]:
    """Each prompt's declared version, or its content hash when it declares
    none; the inline dedupe prompt by hash."""
    out = {}
    for name in PROMPT_NAMES:
        text = prompts.get(name)
        if text is None:
            continue
        m = re.search(r"^Version: `([^`]+)`", text, re.MULTILINE)
        out[name] = m.group(1) if m else _hash(text)
    out[DEDUPE_PROMPT_NAME] = _hash(stages.DEDUPE_SYSTEM)
    return out


async def _gather(coros: Iterable[Coroutine[Any, Any, Any]]) -> list[Any]:
    """gather that cancels the siblings when one fails."""
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(c) for c in coros]
    return [t.result() for t in tasks]


# What the judgement being made is about: the argument revisions and the
# conversations it is asked about. Every word the call reads is in its own
# digest, so this is the identity the step records beside it; an argument the
# call never mentions cannot invalidate it, and one whose words changed does,
# through the digest. Set per task, so concurrent judgements do not mix.
_NAMED: contextvars.ContextVar[dict[str, list[str]] | None] = contextvars.ContextVar("tensions_named", default=None)


def named_inputs() -> dict[str, list[str]]:
    return dict(_NAMED.get() or {})


@contextlib.contextmanager
def naming(*, revisions: Iterable[str] = (), conversations: Iterable[str] = ()) -> Any:
    named = {"revisionIds": sorted(set(revisions)), "conversations": sorted(set(conversations))}
    token = _NAMED.set({key: value for key, value in named.items() if value})
    try:
        yield
    finally:
        _NAMED.reset(token)


def _input_set(
    arguments: Sequence[ArgumentRevision],
    sources: Sequence[SourcePassages],
    input_set: InputSet | None,
) -> InputSet:
    """Invalid inputs fail here, before any call."""
    kinds = {a.type for a in arguments}
    if not kinds <= {"argument", "deduplicated_argument"}:
        raise ValueError(f"tensions read arguments, not {sorted(kinds)}")
    if len(kinds) > 1:
        raise ValueError("tensions read one argument set: raw or deduplicated, not both")
    derived: InputSet | None = (
        None if not kinds else ("deduplicated" if "deduplicated_argument" in kinds else "raw")
    )
    if input_set is not None and derived is not None and input_set != derived:
        raise ValueError(f"input set {input_set!r} does not match the arguments ({derived})")
    ids = [a.revision_id for a in arguments]
    if len(set(ids)) != len(ids):
        raise ValueError("an argument revision is pinned twice")
    for a in arguments:
        if a.epistemic_kind not in ("argument", "claim"):
            raise ValueError(f"{a.revision_id}: unknown epistemic kind {a.epistemic_kind!r}")
    conversations = [s.conversation_id for s in sources]
    if len(set(conversations)) != len(conversations):
        raise ValueError("a conversation's source passages are given twice")
    return input_set or derived or "raw"


# ── grounding ───────────────────────────────────────────────────────────


def ground_in(quote: str, keys: Mapping[str, str], order: Sequence[str]) -> tuple[str, str] | None:
    """The first conversation in `order` whose text holds the quote the way the
    arguments recipe grounded it (Map's `ground_quote`: verbatim over collapsed
    whitespace and case, or every fragment around an ellipsis in order), with
    the grounded quote. `keys` are the transcripts' `norm_key`s."""
    for cid in dict.fromkeys(order):
        key = keys.get(cid)
        if key is None:
            continue
        grounded = ground_quote(quote, key)
        if grounded:
            return cid, grounded
    return None


class QuoteRegistry:
    """The quote ids of one run. A quote is registered only when it is grounded
    in a transcript, credited to the conversation it names when that one holds
    it, and the same words from one conversation are one quote."""

    def __init__(self, texts: Mapping[str, str]) -> None:
        self.keys = {cid: norm_key(text) for cid, text in texts.items()}
        self.quotes: list[dict[str, Any]] = []
        self._seen: dict[tuple[str, str], str] = {}

    def add(self, quote: Mapping[str, Any]) -> str | None:
        named = str(quote.get("transcript") or "")
        found = ground_in(str(quote.get("text") or ""), self.keys, [named, *self.keys])
        if found is None:
            return None
        where, grounded = found
        key = (where, grounded.casefold())
        if key not in self._seen:
            qid = f"q{len(self.quotes) + 1}"
            self.quotes.append({"id": qid, "transcript": where, "text": grounded})
            self._seen[key] = qid
        return self._seen[key]

    def add_all(self, quotes: Iterable[Any]) -> list[str]:
        ids: list[str] = []
        for quote in quotes or []:
            qid = self.add(quote) if isinstance(quote, Mapping) else None
            if qid and qid not in ids:
                ids.append(qid)
        return ids


# ── positions ───────────────────────────────────────────────────────────


def _holder(tables: list[str], labels: dict[str, str]) -> str:
    names = [labels.get(t) or t for t in tables]
    if len(names) == 1:
        return f"a speaker in {names[0]}"
    if len(names) == 2:
        return f"speakers in {names[0]} and {names[1]}"
    return f"speakers in {len(names)} conversations"


def positions_from_arguments(
    arguments: Sequence[ArgumentRevision],
    sources: Sequence[SourcePassages],
    *,
    members: Sequence[ArgumentRevision] = (),
) -> tuple[list[dict[str, Any]], Coverage]:
    """Every argument with evidence in a conversation whose passages are at
    hand becomes a position, with no model call. Its `evidence` holds the
    quotes grounded as the arguments recipe grounds them: in the conversation
    the evidence names first, then in the argument's other conversations. An
    argument none of whose quotes is found can never hold a pole, so it is not
    a position at all: it is counted under `evidence_not_found` and costs no
    call."""
    order = [s.conversation_id for s in sources]
    texts = {s.conversation_id: s.text for s in sources if s.text}
    keys = {cid: norm_key(text) for cid, text in texts.items()}
    labels = {s.conversation_id: s.label for s in sources}
    by_member = {m.revision_id: m for m in members}
    coverage = Coverage(arguments=len(arguments), conversations=len(sources))
    positions: list[dict[str, Any]] = []
    for arg in arguments:
        evidence = list(arg.evidence)
        missing = []
        for mid in arg.member_revision_ids:
            member = by_member.get(mid)
            if member is None:
                missing.append(mid)
            else:
                evidence += list(member.evidence)
        if missing:
            coverage.members_missing[arg.revision_id] = missing
        evidence = [e for e in evidence if e.quote.strip()]
        if not evidence:
            coverage.without_evidence.append(arg.revision_id)
            continue
        named = list(dict.fromkeys(e.conversation_id for e in evidence))
        available = [c for c in order if c in named and c in texts]
        if not available:
            coverage.without_source.append(arg.revision_id)
            continue
        found: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for e in evidence:
            if e.conversation_id not in texts:
                continue
            located = ground_in(e.quote, keys, [e.conversation_id, *available])
            if located is None:
                continue
            where, grounded = located
            if (where, grounded.casefold()) in seen:
                continue
            seen.add((where, grounded.casefold()))
            found.append(
                {
                    "transcript": where,
                    "text": grounded,
                    "location": e.location if where == e.conversation_id else None,
                }
            )
        if not found:
            coverage.evidence_not_found.append(arg.revision_id)
            continue
        own = found[0]["transcript"]
        tables = [own] + [c for c in available if c != own]
        positions.append(
            {
                "revision_id": arg.revision_id,
                "object_id": arg.object_id,
                "member_revision_ids": list(arg.member_revision_ids),
                "position": arg.statement.strip(),
                "holder": _holder(tables, labels),
                "kind": arg.epistemic_kind,
                "hedged": bool(HEDGED.search(arg.statement)),
                "quote": found[0]["text"],
                "transcript": own,
                "tables": tables,
                "verbatim": True,
                "evidence": found,
            }
        )
    coverage.conversations_with_evidence = len(
        {q["transcript"] for p in positions for q in p["evidence"]}
    )
    return positions, coverage


def _trim(
    positions: list[dict[str, Any]], order: list[str], cap: int
) -> tuple[list[dict[str, Any]], list[str]]:
    """Popcorn's exact, fair cap over positions grouped by their own
    conversation; the positions come back numbered P1, P2, ..."""
    grouped: dict[str, list[dict[str, Any]]] = {c: [] for c in order}
    for p in positions:
        grouped.setdefault(p["transcript"], []).append(p)
    kept = stages.trim_positions(grouped, cap=cap)
    kept_ids = {id(p) for items in kept.values() for p in items}
    trimmed = [p["revision_id"] for p in positions if id(p) not in kept_ids]
    numbered: list[dict[str, Any]] = []
    for items in kept.values():
        for p in items:
            numbered.append({"id": f"P{len(numbered) + 1}", **p})
    return numbered, trimmed


# ── 2. collisions, several focal positions per call ─────────────────────


def _table_keys(positions: list[dict[str, Any]], tables: Sequence[str]) -> dict[str, str]:
    order = list(tables)
    for p in positions:
        for tid in stages.tables_of(p):
            if tid not in order:
                order.append(tid)
    return {t: f"T{i + 1}" for i, t in enumerate(order)}


def listing(positions: list[dict[str, Any]], tables: Sequence[str]) -> str:
    key = _table_keys(positions, tables)
    return "\n".join(
        f"{p['id']} [{key[p['transcript']]} · {p.get('holder')} · {p.get('kind')}"
        f"{' · hedged' if p.get('hedged') else ''}] {p['position']}"
        for p in positions
    )


async def find_collisions(
    judge: stages.Judge,
    positions: list[dict[str, Any]],
    *,
    prompt: str,
    tables: Sequence[str],
    batch: int = FOCAL_BATCH,
    max_candidates: int = MAX_CANDIDATES,
    max_per_position: int = MAX_PAIRS_PER_POSITION,
) -> tuple[list[dict[str, Any]], int]:
    """One call per batch of focal positions against the listing of all of
    them. Returns the candidates to verify, ranked and capped, and how many
    pairs were found before the cap."""
    by_id = {p["id"]: p for p in positions}
    rank = {p["id"]: i for i, p in enumerate(positions)}
    listed = data_block("ARGUMENTS", listing(positions, tables))
    ids = [p["id"] for p in positions]

    async def ask(focal: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
        with naming(revisions=[by_id[pid]["revision_id"] for pid in focal]):
            out = await judge(
                prompt, f"{listed}\n\nFOCAL POSITIONS: {', '.join(focal)}", COLLISIONS_SCHEMA, label="collisions"
            )
        return focal, [c for c in (out.get("collisions") or []) if isinstance(c, dict)]

    pairs: dict[tuple[str, str], dict[str, Any]] = {}
    for focal, found in await _gather(ask(ids[i : i + batch]) for i in range(0, len(ids), batch)):
        for c in found:
            pid = str(c.get("focal") or "").strip()
            other = str(c.get("other") or "").strip()
            if pid not in focal or other not in by_id or other == pid:
                continue
            try:
                score = float(c.get("zero_sum") or 0)
            except (TypeError, ValueError):
                continue
            if score < stages.MIN_ZERO_SUM:
                continue
            a, b = sorted((pid, other), key=rank.__getitem__)
            prev = pairs.get((a, b))
            if prev is None or score > prev["zero_sum"]:
                pairs[(a, b)] = {
                    "a": a,
                    "b": b,
                    "zero_sum": score,
                    "why": str(c.get("why") or ""),
                    "question": str(c.get("question") or "").strip(),
                    "cross_table": set(stages.tables_of(by_id[a])) != set(stages.tables_of(by_id[b])),
                    "named_by": (prev["named_by"] if prev else []) + [pid],
                }
            else:
                prev["named_by"].append(pid)

    def order(c: dict[str, Any]) -> tuple[bool, float, int, int, int]:
        return (not c["cross_table"], -c["zero_sum"], -len(c["named_by"]), rank[c["a"]], rank[c["b"]])

    ranked = sorted(pairs.values(), key=order)
    uses: Counter[str] = Counter()
    chosen: list[dict[str, Any]] = []

    def take(c: dict[str, Any]) -> bool:
        if any(c is x for x in chosen) or uses[c["a"]] >= max_per_position or uses[c["b"]] >= max_per_position:
            return False
        chosen.append(c)
        uses.update((c["a"], c["b"]))
        return True

    # The best pair of every conversation is verified whatever its rank, so a
    # quiet conversation is not squeezed out by two loud ones; the rest fill by
    # rank, and no argument takes part in more than `max_per_position` pairs.
    seen_tids: set[str] = set()
    for c in ranked:
        tids = stages.tables_of(by_id[c["a"]]) + stages.tables_of(by_id[c["b"]])
        if any(t not in seen_tids for t in tids) and take(c):
            seen_tids.update(tids)
    for c in ranked:
        if len(chosen) >= max_candidates:
            break
        take(c)
    chosen.sort(key=order)
    return chosen, len(ranked)


# ── 3. verification: one question, opposite answers ────────────────────


def _corpus(transcripts: Mapping[str, str], tids: Sequence[str]) -> str:
    return "\n\n".join(f"TRANSCRIPT id: {t}\n{transcripts[t]}\nEND TRANSCRIPT {t}" for t in tids)


def _said(position: Mapping[str, Any]) -> str:
    return "\n".join(f'   said: "{q["text"]}"' for q in position["evidence"][:QUOTES_PER_POLE])


async def verify_candidates(
    judge: stages.Judge,
    candidates: list[dict[str, Any]],
    by_id: Mapping[str, dict[str, Any]],
    *,
    prompt: str,
    transcripts: Mapping[str, str],
    handed_text: str,
) -> list[dict[str, Any]]:
    """One call per candidate pair. A pair is valid only when the verifier says
    both arguments answer one named question in opposite directions and names
    both poles. Pole A is the pair's `a` argument, pole B its `b`, and the
    quotes holding each pole are that argument's grounded evidence."""

    async def verify(c: dict[str, Any]) -> dict[str, Any]:
        a, b = by_id[c["a"]], by_id[c["b"]]
        ts = sorted(set(stages.tables_of(a)) | set(stages.tables_of(b)))
        user = (
            f"{_corpus(transcripts, ts)}\n\nWHAT THE ROOMS WERE HANDED:\n{handed_text}\n\n"
            f"FLAGGED ON THE QUESTION: {c['question'] or '(none named)'}\n"
            f"Flagged because: {c['why']}\n\n"
            f"THE PAIR:\nA ({a.get('holder')}, {a.get('kind')}): {a['position']}\n{_said(a)}\n"
            f"B ({b.get('holder')}, {b.get('kind')}): {b['position']}\n{_said(b)}"
        )
        with naming(revisions=[a["revision_id"], b["revision_id"]], conversations=ts):
            out = await judge(prompt, user, VERIFY_SCHEMA, label="verify")
        pole_a = str(out.get("poleA") or "").strip()
        pole_b = str(out.get("poleB") or "").strip()
        question = str(out.get("question") or "").strip()
        opposed = bool(out.get("opposed"))
        return {
            **c,
            "valid": bool(out.get("valid")) and opposed and bool(pole_a and pole_b and question),
            "opposed": opposed,
            "question": question or c["question"],
            "verify_why": str(out.get("reason") or "").strip(),
            "poleA": pole_a,
            "poleB": pole_b,
            "quotesA": list(a["evidence"][:QUOTES_PER_POLE]),
            "quotesB": list(b["evidence"][:QUOTES_PER_POLE]),
            "transcripts": ts,
        }

    return await _gather(verify(c) for c in candidates)


# ── 5. support: confirmed arguments only ────────────────────────────────


async def confirm_support(
    judge: stages.Judge,
    kept: list[dict[str, Any]],
    by_id: Mapping[str, dict[str, Any]],
    *,
    prompt: str,
    max_supporters: int = MAX_SUPPORTERS_PER_POLE,
) -> list[dict[str, Any]]:
    """One call per kept tension over every argument proposed for it (its
    pair and its facets), without saying which pole each was proposed for.
    Each argument gets one answer, so it can never hold both poles of one
    tension. Confirmed supporters are ranked by strength, earliest proposed on
    a tie, and capped per pole. A tension whose pair lands on the other poles,
    or with a pole left empty, is marked with its problem."""

    async def confirm(k: dict[str, Any]) -> dict[str, Any]:
        proposed: dict[str, dict[str, Any]] = {}
        for side in ("A", "B"):
            for s in k[f"support{side}"]:
                proposed.setdefault(s["position"], s)
        for pid in k.get("both_poles") or []:
            proposed.setdefault(pid, {"position": pid, "pair": [k["a"], k["b"]], "via": "facet", "verify_why": k["verify_why"]})
        ids = [pid for pid in proposed if pid in by_id]
        lines: list[str] = []
        for pid in ids:
            lines.append(f"{pid} [{by_id[pid].get('kind')}] {by_id[pid]['position']}")
            lines.append(_said(by_id[pid]))
        user = (
            f"QUESTION: {k['question']}\nPOLE A: {k['poleA']}\nPOLE B: {k['poleB']}\n\n"
            + data_block("ARGUMENTS", "\n".join(lines))
        )
        with naming(revisions=[by_id[pid]["revision_id"] for pid in ids]):
            out = await judge(prompt, user, SUPPORT_SCHEMA, label="support")
        answers: dict[str, dict[str, Any]] = {}
        for entry in out.get("supporters") or []:
            if not isinstance(entry, dict):
                continue
            pid = str(entry.get("id") or "").strip()
            if pid not in proposed or pid in answers:
                continue
            try:
                strength = min(1.0, max(0.0, float(entry.get("strength") or 0)))
            except (TypeError, ValueError):
                strength = 0.0
            pole = entry.get("pole")
            answers[pid] = {
                "pole": pole if pole in ("A", "B") else "neither",
                "strength": strength,
                "why": str(entry.get("why") or "").strip(),
            }
        confirmed: dict[str, list[dict[str, Any]]] = {"A": [], "B": []}
        rejected: list[dict[str, Any]] = []
        for index, pid in enumerate(ids):
            answer = answers.get(pid)
            if answer is None or answer["pole"] == "neither" or answer["strength"] < MIN_SUPPORT_STRENGTH:
                rejected.append({"position": pid, **(answer or {"pole": "unanswered"})})
                continue
            confirmed[answer["pole"]].append(
                {
                    **proposed[pid],
                    "position": pid,
                    "pole": answer["pole"],
                    "strength": answer["strength"],
                    "support_why": answer["why"],
                    "proposed_order": index,
                }
            )
        capped: list[str] = []
        for side in ("A", "B"):
            ranked = sorted(confirmed[side], key=lambda s: (-s["strength"], s["proposed_order"]))
            confirmed[side] = ranked[:max_supporters]
            capped += [s["position"] for s in ranked[max_supporters:]]
        on_a = {s["position"] for s in confirmed["A"]}
        on_b = {s["position"] for s in confirmed["B"]}
        problem = None
        if k["a"] in on_b or k["b"] in on_a:
            problem = "the support check put the pair's own arguments on the opposite poles"
        elif not on_a or not on_b:
            problem = "a pole has no confirmed supporting argument"
        return {
            **k,
            "confirmedA": confirmed["A"],
            "confirmedB": confirmed["B"],
            "support_rejected": rejected,
            "support_capped": capped,
            "support_problem": problem,
        }

    return await _gather(confirm(k) for k in kept)


# ── 6. writing, with a completeness gate ────────────────────────────────

ELLIPSIS = re.compile(r"\.\.\.|…")
# A clause elided to a bare negation or "otherwise": "; don't, and ...".
ELIDED = re.compile(r"(?:^|[;:,]\s*)(?:don't|don’t|dont|do not|not|otherwise)\s*[,;.]", re.IGNORECASE)
CLAUSE_BREAK = re.compile(r"[;:]|\s[-–—]\s")
PAYS_BOTH = re.compile(r"[;,]|\b(?:and|but|while|whereas|or)\b", re.IGNORECASE)
REPEATED = re.compile(r"\b(\w+)\s+\1\b", re.IGNORECASE)
DANGLING = frozenset(
    {"and", "or", "but", "because", "so", "to", "the", "a", "an", "of", "with", "without", "if", "while", "than"}
)


def completeness_flags(tension: Mapping[str, Any]) -> list[str]:
    """What the screen gate does not catch: a knot or question that is not a
    finished, whole sentence."""
    tid = tension.get("id", "?")
    flags: list[str] = []
    for name in ("poleA", "poleB", "knot", "toResolve"):
        if ELLIPSIS.search(str(tension.get(name) or "")):
            flags.append(f"{tid} {name}: has an ellipsis; write it out in full")
    knot = str(tension.get("knot") or "").strip()
    question = str(tension.get("toResolve") or "").strip()
    if knot:
        if not knot.endswith((".", "!")):
            flags.append(f"{tid} knot: not a finished sentence ending in a full stop: {knot!r}")
        elided = ELIDED.search(knot)
        if elided:
            flags.append(
                f"{tid} knot: an elided clause ({elided.group(0).strip(' ;:,')!r}); give every clause "
                f"its own subject and verb: {knot!r}"
            )
        for clause in CLAUSE_BREAK.split(knot):
            if 0 < len(clause.split()) < 3:
                flags.append(f"{tid} knot: {clause.strip()!r} is not a whole clause: {knot!r}")
        if not PAYS_BOTH.search(knot):
            flags.append(f"{tid} knot: does not say what each side pays: {knot!r}")
        if knot.count('"') % 2 or knot.count("(") != knot.count(")"):
            flags.append(f"{tid} knot: unbalanced quotation marks or brackets: {knot!r}")
        repeated = REPEATED.search(knot)
        if repeated:
            flags.append(f"{tid} knot: {repeated.group(0)!r} repeats a word: {knot!r}")
    if question and not question.endswith("?"):
        flags.append(f"{tid} toResolve: not a question ending in a question mark: {question!r}")
    for name, text in (("knot", knot), ("toResolve", question)):
        words = re.sub(r"[^\w']+$", "", text).split()
        if words and words[-1].casefold() in DANGLING:
            flags.append(f"{tid} {name}: ends on {words[-1]!r}: {text!r}")
    return flags


def write_flags(tension: Mapping[str, Any]) -> list[str]:
    return screen_flags({"tensions": [dict(tension)]}) + completeness_flags(tension)


def _holding(supporters: list[dict[str, Any]], by_id: Mapping[str, dict[str, Any]]) -> str:
    return " | ".join(
        f'"{by_id[s["position"]]["evidence"][0]["text"]}"' for s in supporters if by_id[s["position"]]["evidence"]
    )


async def write_tensions(
    judge: stages.Judge,
    items: list[dict[str, Any]],
    by_id: Mapping[str, dict[str, Any]],
    *,
    prompt: str,
    host_note: str = "",
) -> list[tuple[dict[str, Any], list[str]]]:
    """The knot and the question of every supported tension, with the flags
    left after one retry. A host note on voice reaches this stage alone."""

    async def write(k: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        facets = [
            f"- {by_id[m['a']]['position']}  /  {by_id[m['b']]['position']}"
            for m in k.get("merged", [])
            if m.get("a") in by_id and m.get("b") in by_id
        ]
        note = (
            f"HOST NOTE ON VOICE (from the facilitator; every rule above still holds):\n{host_note}\n\n"
            if host_note
            else ""
        )
        user = (
            f"{note}QUESTION: {k['question']}\nPOLE A: {k['poleA']}\nPOLE B: {k['poleB']}\n"
            f"HOLDING A: {_holding(k['confirmedA'], by_id)}\n"
            f"HOLDING B: {_holding(k['confirmedB'], by_id)}\n"
            f"WHAT COLLIDES: {k['why']}"
            + (
                "\nFACETS OF THE SAME PULL, FOUND IN OTHER ROOMS (a middle course among them belongs in the "
                "knot, not as a resolution but as what the room reached for):\n" + "\n".join(facets)
                if facets
                else ""
            )
        )

        def shaped(out: dict[str, Any]) -> dict[str, Any]:
            return {
                "id": k["id"],
                "poleA": str(out.get("poleA") or "").strip() or k["poleA"],
                "poleB": str(out.get("poleB") or "").strip() or k["poleB"],
                "knot": str(out.get("knot") or "").strip(),
                "toResolve": str(out.get("toResolve") or "").strip(),
            }

        supporters = [*k["confirmedA"], *k["confirmedB"]]
        with naming(revisions=[by_id[s["position"]]["revision_id"] for s in supporters]):
            t = shaped(await judge(prompt, user, WRITE_SCHEMA, label="write"))
            flags = write_flags(t)
            if flags:
                retry_prompt = (
                    prompt
                    + "\n\n## Your previous answer failed these checks\n\n"
                    + "\n".join(f"- {f}" for f in flags)
                    + "\n\nFix every one of them."
                )
                t = shaped(await judge(retry_prompt, user, WRITE_SCHEMA, label="write"))
                flags = write_flags(t)
        return t, flags

    return await _gather(write(k) for k in items)


# ── the pipeline ────────────────────────────────────────────────────────


async def _framing(judge: stages.Judge, transcripts: dict[str, str], prompt: str) -> list[dict[str, Any]]:
    """Popcorn's handed stage, naming the conversations it reads."""
    with naming(conversations=list(transcripts)):
        return await stages.find_handed(judge, transcripts, prompt=prompt)


async def run_tensions(
    arguments: Sequence[ArgumentRevision],
    sources: Sequence[SourcePassages],
    *,
    generate: stages.Generate,
    prompts: Mapping[str, str] | None = None,
    members: Sequence[ArgumentRevision] = (),
    input_set: InputSet | None = None,
    host_note: str = "",
    framing: bool | None = None,
    concurrency: int = 8,
    max_tensions: int = MAX_TENSIONS,
    max_positions: int = MAX_POSITIONS,
    min_conversations: int = MIN_CONVERSATIONS,
    focal_batch: int = FOCAL_BATCH,
    max_candidates: int = MAX_CANDIDATES,
    max_pairs_per_position: int = MAX_PAIRS_PER_POSITION,
    max_supporters: int = MAX_SUPPORTERS_PER_POLE,
) -> TensionsResult:
    """`generate(system_prompt=, user_text=, schema=, thinking=)` is one model
    call returning the structured answer. `framing` runs the handed stage;
    by default it runs when every conversation in play has its full
    transcript, since passage windows cannot say what a room was handed."""
    chosen = _input_set(arguments, sources, input_set)
    prompts = dict(prompts) if prompts is not None else default_prompts()
    versions = prompt_versions(prompts)
    started = time.monotonic()
    order = [s.conversation_id for s in sources]
    texts = {s.conversation_id: s.text for s in sources if s.text}
    full = {s.conversation_id for s in sources if s.full}

    positions, coverage = positions_from_arguments(arguments, sources, members=members)
    positions, coverage.trimmed = _trim(positions, order, max_positions)
    coverage.positions = len(positions)
    by_id = {p["id"]: p for p in positions}
    in_play = [c for c in order if any(c in p["tables"] for p in positions)]
    judge = stages.Judge(generate, concurrency)
    counts: dict[str, int] = {"arguments": len(arguments), "positions": len(positions)}

    def result(status: Literal["ok", "insufficient_coverage"], **kw: Any) -> TensionsResult:
        needs_refresh = (
            coverage.thin
            or coverage.without_evidence
            or coverage.without_source
            or coverage.evidence_not_found
        )
        return TensionsResult(
            status=status,
            input_set=chosen,
            input_revision_ids=[a.revision_id for a in arguments],
            coverage=coverage,
            counts=counts,
            usage={
                "calls": judge.calls,
                "retries": judge.retries,
                "calls_by_stage": dict(judge.by_label),
                "wall_ms": int((time.monotonic() - started) * 1000),
                "tokens": None,  # the generate contract returns the answer only
            },
            prompt_versions=versions,
            suggestion=SUGGEST_REFRESH if needs_refresh else None,
            **{"tensions": [], "relations": [], "quotes": [], **kw},
        )

    if coverage.conversations_with_evidence < min_conversations or len(positions) < 2:
        coverage.thin = True
        coverage.note = (
            f"{coverage.conversations_with_evidence} conversation(s) have arguments whose "
            f"evidence was found in their source; tensions need at least {min_conversations}. "
            "Refresh the arguments, or add source passages for the conversations listed."
        )
        return result("insufficient_coverage")

    assess = framing if framing is not None else all(c in full for c in in_play)
    coverage.framing = "assessed" if assess else "not_assessed"
    needed = ["collisions", "verify", "support", "write"] + (["handed"] if assess else [])
    missing = [n for n in needed if n not in prompts]
    if missing:
        raise ValueError(f"missing prompts: {missing}")

    # 1 and 2 beside each other: collisions do not read the handed list.
    async with asyncio.TaskGroup() as group:
        handed_task = group.create_task(_framing(judge, {c: texts[c] for c in in_play if c in full}, prompts["handed"])) if assess else None
        collisions_task = group.create_task(
            find_collisions(
                judge,
                positions,
                prompt=prompts["collisions"],
                tables=order,
                batch=focal_batch,
                max_candidates=max_candidates,
                max_per_position=max_pairs_per_position,
            )
        )
    handed: list[dict[str, Any]] = handed_task.result() if handed_task else []
    handed_text = stages.handed_listing(handed) if assess else NOT_ASSESSED
    candidates, found_pairs = collisions_task.result()
    judge.stage("collisions", candidates=len(candidates), found=found_pairs)

    verified = await verify_candidates(
        judge, candidates, by_id, prompt=prompts["verify"], transcripts=texts, handed_text=handed_text
    )
    valid = [v for v in verified if v["valid"]]
    coverage.rejected_pairs = [
        {
            "pair": [by_id[v["a"]]["revision_id"], by_id[v["b"]]["revision_id"]],
            "opposed": v["opposed"],
            "reason": v["verify_why"],
        }
        for v in verified
        if not v["valid"]
    ]
    judge.stage("verify", verified=len(valid), of=len(verified))

    kept = await stages.dedupe_tensions(judge, valid, max_tensions=max_tensions)
    both_poles = [by_id[pid]["revision_id"] for k in kept for pid in k.get("both_poles") or []]
    coverage.both_poles_skipped = list(dict.fromkeys(both_poles))

    checked = await confirm_support(judge, kept, by_id, prompt=prompts["support"], max_supporters=max_supporters)
    supported = [k for k in checked if not k["support_problem"]]
    coverage.unsupported = [
        {
            "poles": [k["poleA"], k["poleB"]],
            "pair": [by_id[k["a"]]["revision_id"], by_id[k["b"]]["revision_id"]],
            "reason": k["support_problem"],
        }
        for k in checked
        if k["support_problem"]
    ]
    coverage.support_rejected = sum(len(k["support_rejected"]) for k in checked)
    coverage.support_capped = sum(len(k["support_capped"]) for k in checked)
    judge.stage("support", supported=len(supported), of=len(checked))

    written = await write_tensions(judge, supported, by_id, prompt=prompts["write"], host_note=host_note)

    book = QuoteRegistry(texts)
    locations = {
        (q["transcript"], q["text"].casefold()): q.get("location") for p in positions for q in p["evidence"]
    }
    tensions: list[Tension] = []
    relations: list[SupportRelation] = []
    gate_flags: list[str] = []
    unsupported_gate = 0
    for (written_tension, flags), item in zip(written, supported, strict=True):
        key = f"x{len(tensions) + 1}"
        supporters: dict[str, list[PoleSupporter]] = {"A": [], "B": []}
        deck: dict[str, list[str]] = {"A": [], "B": []}
        pending: list[SupportRelation] = []
        for side in ("A", "B"):
            for s in item[f"confirmed{side}"]:
                p = by_id[s["position"]]
                quote_ids = book.add_all(p["evidence"])
                supporters[side].append(
                    PoleSupporter(
                        revision_id=p["revision_id"],
                        object_id=p["object_id"],
                        member_revision_ids=list(p["member_revision_ids"]),
                        quote_ids=quote_ids,
                        strength=s["strength"],
                        why=s["support_why"],
                    )
                )
                check: dict[str, Any] = {
                    "step": "support",
                    "prompt": versions["support"],
                    "strength": s["strength"],
                    "why": s["support_why"],
                    "via": s.get("via"),
                    "pair": [by_id[x]["revision_id"] for x in s.get("pair") or [] if x in by_id],
                    "verify": s.get("verify_why") or item["verify_why"],
                    "question": item["question"],
                    "evidence": "argument evidence grounded in its source",
                }
                if s.get("via") == "facet":
                    check["dedupe"] = {
                        "prompt": versions[DEDUPE_PROMPT_NAME],
                        "why": s.get("dedupe_why", ""),
                        "swapped": bool(s.get("swapped")),
                    }
                pending.append(
                    SupportRelation(
                        type=RELATION_BY_POLE[side],
                        from_revision_id=p["revision_id"],
                        to_tension=key,
                        basis="extracted",
                        check=check,
                    )
                )
        for side in ("A", "B"):
            # The deck's quotes: every supporter's first quote, strongest
            # supporter first, then their second, up to the pole's share.
            for round_ in range(QUOTES_PER_POLE):
                for supporter in supporters[side]:
                    if len(deck[side]) >= QUOTES_PER_POLE or round_ >= len(supporter.quote_ids):
                        continue
                    if supporter.quote_ids[round_] not in deck[side]:
                        deck[side].append(supporter.quote_ids[round_])
        if not (deck["A"] and deck["B"]):
            unsupported_gate += 1
            continue
        relations += pending
        tensions.append(
            Tension(
                key=key,
                pole_a=written_tension["poleA"],
                pole_b=written_tension["poleB"],
                knot=written_tension["knot"],
                to_resolve=written_tension["toResolve"],
                quote_ids=deck["A"] + [q for q in deck["B"] if q not in deck["A"]],
                quotes=[],  # resolved below, once the registry is complete
                supporters_a=supporters["A"],
                supporters_b=supporters["B"],
                screen_flags=list(flags),
                question=item["question"],
            )
        )
        gate_flags += flags

    refs = {
        q["id"]: QuoteRef(
            id=q["id"],
            conversation_id=q["transcript"],
            text=q["text"],
            location=locations.get((q["transcript"], q["text"].casefold())),
        )
        for q in book.quotes
    }
    tensions = [replace(t, quotes=[refs[i] for i in t.quote_ids if i in refs]) for t in tensions]
    counts.update(
        {
            "handed": len(handed),
            "handed_verified": sum(1 for h in handed if h["verified"]),
            "candidates": len(candidates),
            "found_pairs": found_pairs,
            "cross_table": sum(1 for c in candidates if c["cross_table"]),
            "verified": len(valid),
            "rejected": len(coverage.rejected_pairs),
            "merged": sum(len(k.get("merged") or []) for k in kept),
            "both_poles_skipped": len(both_poles),
            "kept": len(kept),
            "unsupported_after_support": len(coverage.unsupported),
            "support_rejected": coverage.support_rejected,
            "support_capped": coverage.support_capped,
            "unsupported_gate": unsupported_gate,
            "flagged": sum(1 for t in tensions if t.screen_flags),
            "tensions": len(tensions),
        }
    )
    judge.stage("write", tensions=len(tensions), flags_left=len(gate_flags))
    return result(
        "ok",
        tensions=tensions,
        relations=relations,
        quotes=list(refs.values()),
        gate_flags=gate_flags,
    )


# ── the model call ──────────────────────────────────────────────────────

TOKEN_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")


async def generate_with_usage(
    *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool = True
) -> tuple[dict[str, Any], dict[str, int]]:
    """Popcorn's analysis judgement (same group, token cap and timeout), with
    the provider's token usage alongside the answer."""
    from dembrane.llms import arouter_completion
    from dembrane.map.model import usage_of, choice_text, json_from_text
    from dembrane.popcorn.model import ANALYSIS_MAX_TOKENS, ANALYSIS_TIMEOUT_SECONDS, popcorn_model

    kwargs: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "temperature": 0,
        "max_tokens": ANALYSIS_MAX_TOKENS,
        "response_format": {"type": "json_object", "response_schema": schema},
    }
    if not thinking:
        kwargs["thinkingConfig"] = {"thinkingBudget": 0}
    response = await asyncio.wait_for(
        arouter_completion(popcorn_model(), **kwargs), timeout=ANALYSIS_TIMEOUT_SECONDS
    )
    try:
        answer = json_from_text(choice_text(response))
    except ValueError as exc:
        raise ValueError("model answer did not parse") from exc
    return answer, usage_of(response)


# ── recipe ──────────────────────────────────────────────────────────────

POSITIONS_CHECK = "evidence-grounded-v2"
REVIEW_CHECK = "tensions-review-v2"
INPUT_TYPES: dict[str, ArgumentType] = {
    "arguments": "argument",
    "deduplicated_arguments": "deduplicated_argument",
}
STAGE_BY_SCHEMA: tuple[tuple[dict[str, Any], str], ...] = (
    (stages.HANDED_SCHEMA, "framing"),
    (COLLISIONS_SCHEMA, "collisions"),
    (VERIFY_SCHEMA, "verify"),
    (stages.DEDUPE_SCHEMA, "dedupe"),
    (SUPPORT_SCHEMA, "support"),
    (WRITE_SCHEMA, "write"),
)
_VERSIONS = prompt_versions(default_prompts())


def _prompt_ref(name: str) -> str:
    folder, file = PROMPT_FILES[name]
    package = "dembrane/popcorn/prompts" if folder == POPCORN_PROMPTS else "dembrane/analysis/prompts"
    return f"{package}/{file}.md"


RECIPE_STEPS = (
    StepDef(
        "positions",
        "2",
        StepKind.CHECK,
        "Every argument becomes a position when its evidence is grounded in its source as Map grounds it",
        check_version=POSITIONS_CHECK,
    ),
    StepDef(
        "framing",
        "1",
        StepKind.MODEL,
        "What the rooms were handed, when full transcripts are at hand",
        prompt_ref=_prompt_ref("handed"),
        prompt_version=_VERSIONS["handed"],
    ),
    StepDef(
        "collisions",
        "2",
        StepKind.MODEL,
        "Which arguments collide with a batch of focal arguments, on which question and how zero-sum",
        prompt_ref=_prompt_ref("collisions"),
        prompt_version=_VERSIONS["collisions"],
    ),
    StepDef(
        "verify",
        "2",
        StepKind.MODEL,
        "Verify one candidate pair: one question, opposite answers, both held; name the poles or the reason",
        prompt_ref=_prompt_ref("verify"),
        prompt_version=_VERSIONS["verify"],
    ),
    StepDef(
        "dedupe",
        "1",
        StepKind.MODEL,
        "The same tension, a facet of a kept one, or a new one",
        prompt_ref="dembrane/popcorn/tensions.py#DEDUPE_SYSTEM",
        prompt_version=_VERSIONS[DEDUPE_PROMPT_NAME],
    ),
    StepDef(
        "support",
        "1",
        StepKind.MODEL,
        "Which proposed arguments support pole A, pole B or neither of one tension",
        prompt_ref=_prompt_ref("support"),
        prompt_version=_VERSIONS["support"],
    ),
    StepDef(
        "write",
        "2",
        StepKind.MODEL,
        "The knot and the question, with the screen and completeness gates and one retry",
        prompt_ref=_prompt_ref("write"),
        prompt_version=_VERSIONS["write"],
    ),
    StepDef(
        "review",
        "2",
        StepKind.CHECK,
        "Confirmed pinned arguments on both poles, coverage and rejections, and the gates' flags left",
        check_version=REVIEW_CHECK,
    ),
    StepDef("embed", "1", StepKind.DETERMINISTIC, "Embed each tension's projection in the arguments' configuration"),
)


class TensionsParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Which argument set the tensions read: one of them, never both.
    input_set: Literal["arguments", "deduplicated_arguments"]


def _on_arguments(_scope_key: str, parameters: Mapping[str, Any]) -> Sequence[Dependency]:
    return (Dependency(recipe_id=str(parameters["input_set"]), scope_key="project", name="arguments"),)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stage_of(schema: dict[str, Any]) -> str:
    for known, stage in STAGE_BY_SCHEMA:
        if schema is known:
            return stage
    raise RecipeFailed("The tensions pipeline asked for a judgement this recipe does not declare.")


async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
    services = producer_services(request.services)
    transcripts = await services.transcripts(request.project_id)
    return {
        "sources": [{"conversationId": t.id, "textHash": t.text_hash} for t in transcripts],
        "prompts": prompt_versions(default_prompts()),
        # No host note on voice reaches this recipe yet; declared so that one
        # becomes part of the inputs the day it does.
        "hostNote": "",
    }


def _argument(revision: ObjectRevision, member_ids: Sequence[str] = ()) -> ArgumentRevision:
    return ArgumentRevision(
        revision_id=revision.id,
        object_id=revision.object_id,
        type=INPUT_TYPES["deduplicated_arguments" if revision.type == "deduplicated_argument" else "arguments"],
        statement=str(revision.payload["statement"]),
        epistemic_kind=revision.payload["epistemicKind"],
        valence=revision.payload.get("valence"),
        evidence=tuple(
            Evidence(conversation_id=ref.conversation_id, quote=ref.quote or "", location=ref.location)
            for ref in revision_quotes(revision)
        ),
        member_revision_ids=tuple(member_ids),
    )


def _written(tension: Tension) -> bool:
    return all(text.strip() for text in (tension.pole_a, tension.pole_b, tension.knot, tension.to_resolve))


def lineage_key(tension: Tension) -> str:
    """A tension's identity: the argument objects holding each pole. The same
    arguments on the same poles are the same tension, reworded or not."""
    pole_a = "\x1f".join(sorted({s.object_id for s in tension.supporters_a}))
    pole_b = "\x1f".join(sorted({s.object_id for s in tension.supporters_b}))
    return "poles:" + _sha(f"{pole_a}\x1e{pole_b}")[:40]


def _location(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


async def execute(ctx: RecipeContext) -> None:
    services = producer_services(ctx.services)
    deployment = live_model_deployment(ctx)
    input_set = str(ctx.parameters["input_set"])
    expected_type = INPUT_TYPES[input_set]
    pinned = ctx.dependencies["arguments"]
    revisions = sorted(await ctx.input_revisions("arguments"), key=argument_order)
    if any(r.type != expected_type for r in revisions):
        raise RecipeFailed("The pinned arguments are not the argument set this run reads.")

    # Deduplicated arguments carry their members through `derived_from`.
    member_ids_of: dict[str, list[str]] = {}
    member_revisions: dict[str, ObjectRevision] = {}
    if expected_type == "deduplicated_argument":
        pinned_ids = {r.id for r in revisions}
        for relation in pinned.manifest.get("relations") or []:
            if relation["type"] == "derived_from" and relation["from"] in pinned_ids:
                member_ids_of.setdefault(str(relation["from"]), []).append(str(relation["to"]))
        wanted = sorted({m for ids in member_ids_of.values() for m in ids})
        member_revisions = await ctx.store.get_revisions(ctx.project_id, wanted)
        for owner, ids in member_ids_of.items():
            member_ids_of[owner] = sorted(
                ids, key=lambda i: argument_order(member_revisions[i]) if i in member_revisions else ("", "", "", i)
            )
    arguments = [_argument(r, member_ids_of.get(r.id, ())) for r in revisions]
    members = [
        _argument(member_revisions[i]) for i in sorted(member_revisions, key=lambda i: argument_order(member_revisions[i]))
    ]

    # The embedding configuration the tensions share with their arguments.
    config_keys = sorted({str((r.embedding_refs or {})["configKey"]) for r in revisions if (r.embedding_refs or {}).get("configKey")})
    if len(config_keys) > 1:
        raise RecipeFailed("The pinned arguments were embedded in more than one configuration. Refresh the arguments.")
    config_key = config_keys[0] if config_keys else None
    embedding_models = {str((r.embedding_refs or {})["model"]) for r in revisions if (r.embedding_refs or {}).get("model")}

    # Source passages: the full transcripts of the conversations the evidence names.
    transcripts = await load_pinned_transcripts(
        services, ctx.project_id, list(ctx.input_manifest.get("sources") or [])
    )
    labels = {t.id: f"Conversation {index}" for index, t in enumerate(transcripts, start=1)}
    named = {e.conversation_id for a in (*arguments, *members) for e in a.evidence}
    passages = [SourcePassages(t.id, labels[t.id], transcript=t.text) for t in transcripts if t.id in named]
    text_hashes = {t.id: t.text_hash for t in transcripts}
    source_inputs = [{"conversationId": p.conversation_id, "textHash": text_hashes[p.conversation_id]} for p in passages]

    # 0. positions, recorded as a check before the pipeline reads them again
    positions, coverage = positions_from_arguments(arguments, passages, members=members)
    positions_doc = {
        "positions": [
            {"revisionId": p["revision_id"], "conversations": p["tables"], "quotes": len(p["evidence"])}
            for p in positions
        ],
        "coverage": asdict(coverage),
    }
    await ctx.step(
        "positions",
        lambda: _done(
            StepResult(
                output=positions_doc,
                validation=(
                    CheckOutcome(
                        check="evidence-grounded",
                        status=CheckStatus.PASSED,
                        version=POSITIONS_CHECK,
                        evidence={
                            "arguments": len(arguments),
                            "positions": len(positions),
                            "withoutEvidence": coverage.without_evidence,
                            "withoutSource": coverage.without_source,
                            "evidenceNotFound": coverage.evidence_not_found,
                            "membersMissing": coverage.members_missing,
                        },
                    ),
                ),
            )
        ),
        inputs={
            "check": POSITIONS_CHECK,
            "inputSet": input_set,
            "revisionIds": [a.revision_id for a in arguments],
            "memberRevisionIds": [m.revision_id for m in members],
            "sources": source_inputs,
        },
    )

    # 1 to 6: every judgement is a model step of its stage, keyed by its exact
    # call and by what that call is about (the stage names its focal arguments,
    # its pair or its candidates). A judgement that never mentioned an argument
    # is not asked again because that argument changed.
    locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def generate(
        *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool = True
    ) -> dict[str, Any]:
        stage = _stage_of(schema)
        call = {
            "system": _sha(system_prompt),
            "user": _sha(user_text),
            "schema": content_hash(schema),
            "thinking": thinking,
        }
        digest = content_hash(call)

        async def compute() -> StepResult:
            answer, usage = await services.generate(
                system_prompt=system_prompt, user_text=user_text, schema=schema, thinking=thinking
            )
            tokens = {k: int(v) for k, v in usage.items() if k in TOKEN_KEYS}
            return StepResult(output=answer, usage=tokens, model_calls=1)

        # The dedupe stage names nothing: it reads the poles already in its call.
        named = named_inputs()
        async with locks[digest]:
            return dict(
                await ctx.step(
                    stage,
                    compute,
                    instance=digest[:40],
                    inputs={**call, **named, "model": deployment},
                )
            )

    await ctx.progress("finding tensions", force=True, positions=len(positions))
    outcome = await run_tensions(
        arguments,
        passages,
        generate=generate,
        members=members,
        input_set="deduplicated" if expected_type == "deduplicated_argument" else "raw",
        concurrency=ctx.recipe.model_concurrency,
    )

    # review: both poles, pinned arguments only, what the run covered and the gates' flags
    pinned_ids = {a.revision_id for a in arguments}
    problems: list[str] = []
    unwritten: list[str] = []
    for tension in outcome.tensions:
        pole_a = {s.revision_id for s in tension.supporters_a}
        pole_b = {s.revision_id for s in tension.supporters_b}
        if not pole_a or not pole_b:
            problems.append(f"{tension.key}: a pole has no supporting argument")
        if pole_a & pole_b:
            problems.append(f"{tension.key}: an argument supports both poles")
        if (pole_a | pole_b) - pinned_ids:
            problems.append(f"{tension.key}: a supporter is not a pinned argument")
        if len(pole_a) > MAX_SUPPORTERS_PER_POLE or len(pole_b) > MAX_SUPPORTERS_PER_POLE:
            problems.append(f"{tension.key}: more supporters on a pole than the cap")
        if not _written(tension):
            unwritten.append(tension.key)
    in_tensions = Counter(s.revision_id for t in outcome.tensions for s in (*t.supporters_a, *t.supporters_b))
    flagged = {t.key: t.screen_flags for t in outcome.tensions if t.screen_flags and t.key not in unwritten}
    covered = outcome.coverage
    summary = {
        "status": outcome.status,
        "inputSet": input_set,
        "counts": outcome.counts,
        "coverage": asdict(covered),
        "suggestion": outcome.suggestion,
        "gateFlags": outcome.gate_flags,
        "promptVersions": outcome.prompt_versions,
        "callsByStage": outcome.usage.get("calls_by_stage"),
        "unwritten": unwritten,
        "tensions": [
            {
                "key": t.key,
                "question": t.question,
                "supportersA": [{"revisionId": s.revision_id, "strength": s.strength} for s in t.supporters_a],
                "supportersB": [{"revisionId": s.revision_id, "strength": s.strength} for s in t.supporters_b],
                "flags": t.screen_flags,
            }
            for t in outcome.tensions
        ],
        "relations": [
            {"type": r.type, "from": r.from_revision_id, "tension": r.to_tension, "check": r.check}
            for r in outcome.relations
        ],
    }
    await ctx.step(
        "review",
        lambda: _done(
            StepResult(
                output=summary,
                validation=(
                    CheckOutcome(
                        check="both-poles-supported",
                        status=CheckStatus.FAILED if problems else CheckStatus.PASSED,
                        version=REVIEW_CHECK,
                        evidence={
                            "tensions": len(outcome.tensions) - len(unwritten),
                            "relations": len(outcome.relations),
                            "problems": problems,
                            "unwritten": unwritten,
                        },
                    ),
                    CheckOutcome(
                        check="support-confirmed",
                        status=CheckStatus.PASSED,
                        version=REVIEW_CHECK,
                        evidence={
                            "maxPerPole": MAX_SUPPORTERS_PER_POLE,
                            "minStrength": MIN_SUPPORT_STRENGTH,
                            "rejected": covered.support_rejected,
                            "capped": covered.support_capped,
                            "unsupportedTensions": covered.unsupported,
                            "argumentsInSeveralTensions": {rid: n for rid, n in sorted(in_tensions.items()) if n > 1},
                        },
                    ),
                    CheckOutcome(
                        check="tension-coverage",
                        status=CheckStatus.PASSED,
                        version=REVIEW_CHECK,
                        evidence={
                            "status": outcome.status,
                            "suggestion": outcome.suggestion,
                            "inputSet": input_set,
                            "arguments": covered.arguments,
                            "positions": covered.positions,
                            "conversationsWithEvidence": covered.conversations_with_evidence,
                            "withoutEvidence": len(covered.without_evidence),
                            "withoutSource": len(covered.without_source),
                            "evidenceNotFound": len(covered.evidence_not_found),
                            "trimmed": len(covered.trimmed),
                            "bothPolesSkipped": len(covered.both_poles_skipped),
                            "rejectedPairs": covered.rejected_pairs,
                            "framing": covered.framing,
                            "thin": covered.thin,
                        },
                        message=covered.note,
                    ),
                    CheckOutcome(
                        check="screen-gate",
                        status=CheckStatus.NEEDS_REVIEW if flagged else CheckStatus.PASSED,
                        version=REVIEW_CHECK,
                        evidence={"flagsLeft": flagged},
                        message=(
                            f"{len(flagged)} tension(s) still break the screen or completeness gate after the retry."
                            if flagged
                            else None
                        ),
                    ),
                ),
            )
        ),
        inputs={
            "check": REVIEW_CHECK,
            "revisionIds": sorted(pinned_ids),
            "result": artifact_hash(summary),
        },
    )
    if problems:
        return

    emittable = [t for t in outcome.tensions if t.key not in unwritten]
    payloads = {
        t.key: {
            "poleA": t.pole_a,
            "poleB": t.pole_b,
            "knot": t.knot,
            "toResolve": t.to_resolve,
            "quotes": [
                {
                    "text": q.text,
                    "conversationId": q.conversation_id,
                    "location": _location(q.location),
                    "pole": "A" if q.id in {qid for s in t.supporters_a for qid in s.quote_ids} else "B",
                }
                for q in t.quotes
            ],
        }
        for t in emittable
    }

    # embeddings of each tension's projection, in the arguments' configuration
    await ctx.progress("embedding", force=True)
    projection = types.get_object_type("tension").map
    assert projection is not None
    texts = {input_hash(projection.embedding_text(p)): projection.embedding_text(p) for p in payloads.values()}

    async def embed() -> StepResult:
        stored = await ctx.store.load_embeddings(ctx.project_id, config_key, sorted(texts)) if texts and config_key else {}
        ids = {hashed: embedding_id for hashed, (embedding_id, _vector) in stored.items()}
        missing = [hashed for hashed in sorted(texts) if hashed not in stored]
        key, model, computed = config_key, next(iter(embedding_models)) if len(embedding_models) == 1 else None, 0
        if missing:
            identity = await services.probe()
            if config_key is not None and identity.key != config_key:
                raise RecipeFailed(
                    "The embedding deployment changed since the arguments were embedded. Refresh the arguments first."
                )
            service = EmbeddingService(ctx.store, identity=identity, embed=services.embed)
            batch = await service.ensure(ctx.project_id, [texts[hashed] for hashed in missing])
            ids.update(batch.ids)
            key, model, computed = identity.key, identity.model, batch.computed
        durable = await ctx.store.vectors_by_ids(ctx.project_id, sorted(set(ids.values())))
        if len(durable) != len(set(ids.values())):
            raise RecipeFailed("Saving the tensions' vectors failed.")
        return StepResult(output={"ids": ids, "configKey": key, "model": model, "reused": len(stored), "computed": computed})

    hits, resumed = ctx.metrics["cacheHits"], ctx.metrics["stepsResumed"]
    embedded = await ctx.step(
        "embed",
        embed,
        inputs={
            "embeddingConfigKey": config_key,
            "projectionVersion": projection.projection_version,
            "inputHashes": sorted(texts),
        },
    )
    if fresh(ctx, hits, resumed):
        ctx.metrics["embeddingsReused"] += int(embedded["reused"])
        ctx.metrics["embeddingsComputed"] += int(embedded["computed"])

    # objects and relations, against the exact pinned revisions
    await ctx.progress("emitting", force=True)
    by_revision = {r.id: r for r in revisions}
    by_quote = {q.id: q for q in outcome.quotes}
    seen: Counter[str] = Counter()
    for tension in emittable:
        base = lineage_key(tension)
        seen[base] += 1
        key = base if seen[base] == 1 else f"{base}:{seen[base]}"
        supporters = [*tension.supporters_a, *tension.supporters_b]
        payload = payloads[tension.key]
        hashed = input_hash(projection.embedding_text(payload))
        revision = await ctx.emit(
            "tension",
            key,
            payload,
            source_refs=[
                SourceRef(
                    conversation_id=q.conversation_id,
                    source_fingerprint=text_hashes.get(q.conversation_id),
                    quote=q.text,
                    location=_location(q.location),
                )
                for q in tension.quotes
            ],
            input_revision_ids=[s.revision_id for s in supporters],
            embedding_refs={
                **EmbeddingRef(
                    embedding_id=embedded["ids"][hashed],
                    input_hash=hashed,
                    config_key=str(embedded["configKey"]),
                    projection_version=projection.projection_version,
                ).as_json(),
                **({"model": embedded["model"]} if embedded.get("model") else {}),
            },
            extra={"inputSet": input_set, "question": tension.question},
        )
        for relation in outcome.relations:
            if relation.to_tension != tension.key:
                continue
            supporter = next(s for s in supporters if s.revision_id == relation.from_revision_id)
            quotes = [by_quote[qid] for qid in supporter.quote_ids if qid in by_quote]
            await ctx.relate(
                relation.type,
                by_revision[relation.from_revision_id],
                revision,
                basis=relation.basis,
                attributes={
                    "rationale": str(relation.check.get("why") or "") or None,
                    "quotes": [
                        {"text": q.text, "conversationId": q.conversation_id, "location": _location(q.location)}
                        for q in quotes
                    ],
                },
                source_refs=[
                    SourceRef(
                        conversation_id=q.conversation_id,
                        source_fingerprint=text_hashes.get(q.conversation_id),
                        quote=q.text,
                    )
                    for q in quotes
                ],
            )
            ctx.metrics[relation.type] += 1
        ctx.metrics["tensions"] += 1
        if tension.screen_flags:
            ctx.metrics["tensionsFlagged"] += 1


async def _done(result: StepResult) -> StepResult:
    return result


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Tensions",
    purpose=(
        "Find the tensions between saved arguments: two poles answering one question in opposite "
        "directions, the knot between them and the question to resolve, each pole linked to the exact "
        "arguments confirmed to hold it."
    ),
    input_types=("argument", "deduplicated_argument"),
    steps=RECIPE_STEPS,
    output_types=("tension",),
    execute=execute,
    dependencies=_on_arguments,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "reads one argument set, raw or deduplicated, never both",
        "a tension's poles answer one question in opposite directions; a rejected pair keeps its reason",
        "every pole is held by one to three pinned arguments confirmed by the support check, whose "
        "evidence is grounded in its source",
        "an argument is confirmed separately for every tension and never holds both poles of one",
        "a verifier never supplies a side or a quote",
        "a knot or question left broken after the retry puts the run up for review",
        "too little evidence is a valid result that suggests refreshing the arguments",
    ),
    identity_policy=IdentityPolicy(
        description="A tension keeps its identity while the same argument objects hold each of its poles."
    ),
    embedding_projections=("tension",),
    parameters_model=TensionsParameters,
    scope_key_pattern=re.compile(r"^project$"),
    model_config=model_deployment,
    model_concurrency=8,
    # Every step names what it reads of these: the positions check the
    # argument, member and source ids; each judgement its exact call and the
    # argument revisions in it; the review every pinned revision; the embedding
    # its input hashes. So an unchanged judgement is not asked again when an
    # argument it never read changes.
    partitioned_inputs=("sources", "revisionIds", "dependencies.arguments"),
)
