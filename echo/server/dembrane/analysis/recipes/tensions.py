"""Tensions from saved arguments.

The popcorn tick finds tensions by reading every transcript for positions
first. This recipe starts from pinned argument revisions instead (raw or
deduplicated, never both) and runs the same later stages popcorn runs, from
`dembrane.popcorn.tensions`:

0. positions   no model call: every argument revision is one position, its
               holder named after its conversations, its kind its epistemic
               kind, hedged when its statement hedges, its quotes its evidence
               checked word for word against the source passages
1. framing     what the rooms were handed, when full transcripts are at hand
2. collisions  one call per evidenced position against all of them
3. verify      one call per candidate pair with the pair's source passages;
               the verifier confirms meaning and names the poles, it never
               supplies a side or a quote: pole A is argument a, pole B
               argument b, and the quotes are those arguments' evidence
4. dedupe      one call per verified pair against the tensions kept; a facet
               adds its arguments to the pole its quotes go to
5. write       the knot and the question, with the screen gate and one retry;
               the host note on voice reaches this stage only

Evidence is the contract. A tension leaves this module only with at least one
argument revision on each pole whose evidence was found verbatim in its
source, and every such argument becomes a `supports_pole_a` or
`supports_pole_b` relation carrying the check that established it. Zero
tensions is a result. Too little evidence to look for tensions is a result
too: it says so and suggests refreshing the arguments, without a model call.

`run_tensions` is pipeline logic and model calls only. The recipe at the end
of this module runs it through the executor: every judgement becomes a cached
model step of its stage, the positions and the support are recorded as checks,
and tensions and their `supports_pole_a`/`supports_pole_b` relations are
emitted against the exact pinned argument revisions.
"""

from __future__ import annotations

import re
import time
import asyncio
import hashlib
from typing import Any, Literal, Mapping, Sequence
from pathlib import Path
from collections import Counter, defaultdict
from dataclasses import field, asdict, replace, dataclass

from pydantic import BaseModel, ConfigDict

from dembrane.popcorn import tensions as stages
from dembrane.analysis.hashing import content_hash
from dembrane.popcorn.analysis import QuoteBook, norm
from dembrane.analysis.executor import StepResult, RecipeFailed, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, Dependency, InputRequest, IdentityPolicy
from dembrane.analysis.contracts import (
    StepKind,
    SourceRef,
    CheckStatus,
    CheckOutcome,
    ObjectRevision,
)
from dembrane.analysis.recipes.services import model_deployment, producer_services
from dembrane.analysis.recipes.arguments import (
    artifact_hash,
    argument_order,
    revision_quotes,
    live_model_deployment,
    load_pinned_transcripts,
)

RECIPE_ID = "tensions"
RECIPE_VERSION = "tensions-from-arguments-v1"

# The popcorn prompts, reused as they are. The dedupe prompt lives inline in
# the stages module and is identified by its content hash.
PROMPT_NAMES = ("tensions-handed", "collisions", "tension-verify", "tension-write")
DEDUPE_PROMPT_NAME = "tension-dedupe"

# Tensions pull between conversations; one conversation's evidence is not
# enough to look for them.
MIN_CONVERSATIONS = 2
# Every position is one collisions call; the cap and its fairness are
# popcorn's, and whatever it leaves out is reported.
MAX_POSITIONS = stages.MAX_POSITIONS_TOTAL
QUOTES_PER_POLE = 2

STEPS: tuple[dict[str, str], ...] = (
    {"key": "positions", "kind": "deterministic", "check": "evidence verbatim in source passages"},
    {"key": "framing", "kind": "model", "prompt": "tensions-handed"},
    {"key": "collisions", "kind": "model", "prompt": "collisions"},
    {"key": "verify", "kind": "model", "prompt": "tension-verify"},
    {"key": "dedupe", "kind": "model", "prompt": DEDUPE_PROMPT_NAME},
    {"key": "write", "kind": "model", "prompt": "tension-write", "check": "screen gate"},
    {"key": "support", "kind": "deterministic", "check": "evidenced arguments on both poles"},
)

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
    """The popcorn prompt files, read without importing the model client."""
    folder = Path(stages.__file__).with_name("prompts")
    return {name: (folder / f"{name}.md").read_text(encoding="utf-8") for name in PROMPT_NAMES}


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


def _input_set(
    arguments: Sequence[ArgumentRevision],
    sources: Sequence[SourcePassages],
    input_set: InputSet | None,
) -> InputSet:
    """Invalid inputs fail here, before any call."""
    types = {a.type for a in arguments}
    if not types <= {"argument", "deduplicated_argument"}:
        raise ValueError(f"tensions read arguments, not {sorted(types)}")
    if len(types) > 1:
        raise ValueError("tensions read one argument set: raw or deduplicated, not both")
    derived: InputSet | None = (
        None if not types else ("deduplicated" if "deduplicated_argument" in types else "raw")
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
    hand becomes a position, in the stages' shape, with no model call. Its
    `evidence` holds the quotes found word for word: in the conversation the
    evidence names first, then in the argument's other conversations. An
    argument none of whose quotes is found can never hold a pole, so it is not
    a position at all: it is counted under `evidence_not_found` and costs no
    call."""
    order = [s.conversation_id for s in sources]
    texts = {s.conversation_id: s.text for s in sources if s.text}
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
            where = stages.locate(e.quote, texts, [e.conversation_id] + available)
            key = (where or "", norm(e.quote))
            if where is None or key in seen:
                continue
            seen.add(key)
            found.append(
                {
                    "transcript": where,
                    "text": e.quote.strip(),
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


def _pole_quotes(
    _out: dict[str, Any], a: dict[str, Any], b: dict[str, Any]
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """The verifier names the poles; the quotes holding them are the two
    arguments' own verified evidence, never quotes the verifier offers."""
    return list(a["evidence"][:QUOTES_PER_POLE]), list(b["evidence"][:QUOTES_PER_POLE])


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
    max_tensions: int = stages.MAX_TENSIONS,
    max_positions: int = MAX_POSITIONS,
    min_conversations: int = MIN_CONVERSATIONS,
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
    needed = ["collisions", "tension-verify", "tension-write"] + (["tensions-handed"] if assess else [])
    missing = [n for n in needed if n not in prompts]
    if missing:
        raise ValueError(f"missing prompts: {missing}")

    # 1 and 2 beside each other: collisions do not read the handed list.
    async with asyncio.TaskGroup() as group:
        handed_task = (
            group.create_task(
                stages.find_handed(
                    judge,
                    {c: texts[c] for c in in_play if c in full},
                    prompt=prompts["tensions-handed"],
                )
            )
            if assess
            else None
        )
        collisions_task = group.create_task(
            stages.find_collisions(judge, positions, prompt=prompts["collisions"], tables=order)
        )
    handed: list[dict[str, Any]] = handed_task.result() if handed_task else []
    handed_text = stages.handed_listing(handed) if assess else NOT_ASSESSED
    candidates, found_pairs = collisions_task.result()
    judge.stage("collisions", candidates=len(candidates), found=found_pairs)

    verified = await stages.verify_candidates(
        judge,
        candidates,
        by_id,
        prompt=prompts["tension-verify"],
        transcripts=texts,
        handed_text=handed_text,
        pole_quotes=_pole_quotes,
    )
    valid, unsupported_verified = stages.supported(verified)
    judge.stage("verify", verified=len(valid), of=len(verified))

    kept = await stages.dedupe_tensions(judge, valid, max_tensions=max_tensions)
    both_poles = [by_id[pid]["revision_id"] for k in kept for pid in k.get("both_poles") or []]
    coverage.both_poles_skipped = list(dict.fromkeys(both_poles))
    written = await stages.write_tensions(
        judge, kept, by_id, prompt=prompts["tension-write"], host_note=host_note
    )

    book = QuoteBook(texts)
    locations = {
        (q["transcript"], norm(q["text"])): q.get("location")
        for p in positions
        for q in p["evidence"]
    }
    tensions: list[Tension] = []
    relations: list[SupportRelation] = []
    gate_flags: list[str] = []
    unsupported_gate = 0
    for (written_tension, flags), item in zip(written, kept, strict=True):
        poles = {
            side: [s for s in item[f"support{side}"] if by_id[s["position"]]["evidence"]]
            for side in ("A", "B")
        }
        # The deck's quotes first, pole A's then pole B's, so their ids lead.
        ids_a = book.add_all(item["quotesA"])
        ids_b = book.add_all(item["quotesB"])
        if not (poles["A"] and poles["B"] and ids_a and ids_b):
            unsupported_gate += 1
            continue
        key = f"x{len(tensions) + 1}"
        supporters: dict[str, list[PoleSupporter]] = {"A": [], "B": []}
        for side in ("A", "B"):
            for s in poles[side]:
                p = by_id[s["position"]]
                supporters[side].append(
                    PoleSupporter(
                        revision_id=p["revision_id"],
                        object_id=p["object_id"],
                        member_revision_ids=list(p["member_revision_ids"]),
                        quote_ids=book.add_all(p["evidence"]),
                    )
                )
                check: dict[str, Any] = {
                    "step": "verify",
                    "prompt": versions["tension-verify"],
                    "via": s["via"],
                    "pair": [by_id[x]["revision_id"] for x in s["pair"]],
                    "why": s["verify_why"],
                    "evidence": "argument evidence found verbatim in its source",
                }
                if s["via"] == "facet":
                    check["dedupe"] = {
                        "prompt": versions[DEDUPE_PROMPT_NAME],
                        "why": s.get("dedupe_why", ""),
                        "swapped": bool(s.get("swapped")),
                    }
                relations.append(
                    SupportRelation(
                        type=RELATION_BY_POLE[side],
                        from_revision_id=p["revision_id"],
                        to_tension=key,
                        basis="extracted",
                        check=check,
                    )
                )
        quote_ids = ids_a + [q for q in ids_b if q not in ids_a]
        tensions.append(
            Tension(
                key=key,
                pole_a=written_tension["poleA"],
                pole_b=written_tension["poleB"],
                knot=written_tension["knot"],
                to_resolve=written_tension["toResolve"],
                quote_ids=quote_ids,
                quotes=[],  # resolved below, once the book is complete
                supporters_a=supporters["A"],
                supporters_b=supporters["B"],
                screen_flags=list(flags),
            )
        )
        gate_flags += flags

    refs = {
        q["id"]: QuoteRef(
            id=q["id"],
            conversation_id=q["transcript"],
            text=q["text"],
            location=locations.get((q["transcript"], norm(q["text"]))),
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
            "unsupported": unsupported_verified + unsupported_gate,
            "unsupported_no_quote": unsupported_verified,
            "unsupported_gate": unsupported_gate,
            "merged": sum(len(k.get("merged") or []) for k in kept),
            "both_poles_skipped": len(both_poles),
            "kept": len(kept),
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

POSITIONS_CHECK = "evidence-verbatim-v1"
SUPPORT_CHECK = "both-poles-supported-v1"
INPUT_TYPES: dict[str, ArgumentType] = {
    "arguments": "argument",
    "deduplicated_arguments": "deduplicated_argument",
}
STAGE_BY_SCHEMA: tuple[tuple[dict[str, Any], str], ...] = (
    (stages.HANDED_SCHEMA, "framing"),
    (stages.COLLISIONS_SCHEMA, "collisions"),
    (stages.VERIFY_SCHEMA, "verify"),
    (stages.DEDUPE_SCHEMA, "dedupe"),
    (stages.WRITE_SCHEMA, "write"),
)
_VERSIONS = prompt_versions(default_prompts())
_PROMPTS_FOLDER = "dembrane/popcorn/prompts"

RECIPE_STEPS = (
    StepDef(
        "positions",
        "1",
        StepKind.CHECK,
        "Every argument becomes a position when its evidence is found verbatim in its source",
        check_version=POSITIONS_CHECK,
    ),
    StepDef(
        "framing",
        "1",
        StepKind.MODEL,
        "What the rooms were handed, when full transcripts are at hand",
        prompt_ref=f"{_PROMPTS_FOLDER}/tensions-handed.md",
        prompt_version=_VERSIONS["tensions-handed"],
    ),
    StepDef(
        "collisions",
        "1",
        StepKind.MODEL,
        "Which positions one position collides with, and how zero-sum",
        prompt_ref=f"{_PROMPTS_FOLDER}/collisions.md",
        prompt_version=_VERSIONS["collisions"],
    ),
    StepDef(
        "verify",
        "1",
        StepKind.MODEL,
        "Verify one candidate pair against its source passages and name the poles",
        prompt_ref=f"{_PROMPTS_FOLDER}/tension-verify.md",
        prompt_version=_VERSIONS["tension-verify"],
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
        "write",
        "1",
        StepKind.MODEL,
        "The knot and the question, with the screen gate and one retry",
        prompt_ref=f"{_PROMPTS_FOLDER}/tension-write.md",
        prompt_version=_VERSIONS["tension-write"],
    ),
    StepDef(
        "support",
        "1",
        StepKind.CHECK,
        "Every tension has evidenced pinned arguments on both poles; coverage and the refresh suggestion",
        check_version=SUPPORT_CHECK,
    ),
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
    members = [_argument(member_revisions[i]) for i in sorted(member_revisions, key=lambda i: argument_order(member_revisions[i]))]

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
                        check="evidence-verbatim",
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

    # 1 to 5: every judgement is a model step of its stage, keyed by its exact call
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

        async with locks[digest]:
            return dict(
                await ctx.step(stage, compute, instance=digest[:40], inputs={**call, "model": deployment})
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

    # support: both poles, pinned arguments only, and what the run covered
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
        if not _written(tension):
            unwritten.append(tension.key)
    summary = {
        "status": outcome.status,
        "inputSet": input_set,
        "counts": outcome.counts,
        "coverage": asdict(outcome.coverage),
        "suggestion": outcome.suggestion,
        "gateFlags": outcome.gate_flags,
        "promptVersions": outcome.prompt_versions,
        "callsByStage": outcome.usage.get("calls_by_stage"),
        "unwritten": unwritten,
        "tensions": [
            {
                "key": t.key,
                "supportersA": [s.revision_id for s in t.supporters_a],
                "supportersB": [s.revision_id for s in t.supporters_b],
            }
            for t in outcome.tensions
        ],
        "relations": [
            {"type": r.type, "from": r.from_revision_id, "tension": r.to_tension, "check": r.check}
            for r in outcome.relations
        ],
    }
    covered = outcome.coverage
    await ctx.step(
        "support",
        lambda: _done(
            StepResult(
                output=summary,
                validation=(
                    CheckOutcome(
                        check="both-poles-supported",
                        status=CheckStatus.FAILED if problems else CheckStatus.PASSED,
                        version=SUPPORT_CHECK,
                        evidence={
                            "tensions": len(outcome.tensions) - len(unwritten),
                            "relations": len(outcome.relations),
                            "problems": problems,
                            "unwritten": unwritten,
                        },
                    ),
                    CheckOutcome(
                        check="tension-coverage",
                        status=CheckStatus.PASSED,
                        version=SUPPORT_CHECK,
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
                            "framing": covered.framing,
                            "thin": covered.thin,
                        },
                        message=covered.note,
                    ),
                    CheckOutcome(
                        check="screen-gate",
                        status=CheckStatus.PASSED,
                        evidence={"flagsLeft": outcome.gate_flags},
                        message="Screen flags remained after the retry." if outcome.gate_flags else None,
                    ),
                ),
            )
        ),
        inputs={
            "check": SUPPORT_CHECK,
            "revisionIds": sorted(pinned_ids),
            "result": artifact_hash(summary),
        },
    )
    if problems:
        return

    # objects and relations, against the exact pinned revisions
    await ctx.progress("emitting", force=True)
    by_revision = {r.id: r for r in revisions}
    by_quote = {q.id: q for q in outcome.quotes}
    seen: Counter[str] = Counter()
    for tension in outcome.tensions:
        if tension.key in unwritten:
            continue
        pole_a_quotes = {qid for s in tension.supporters_a for qid in s.quote_ids}
        base = lineage_key(tension)
        seen[base] += 1
        key = base if seen[base] == 1 else f"{base}:{seen[base]}"
        supporters = [*tension.supporters_a, *tension.supporters_b]
        revision = await ctx.emit(
            "tension",
            key,
            {
                "poleA": tension.pole_a,
                "poleB": tension.pole_b,
                "knot": tension.knot,
                "toResolve": tension.to_resolve,
                "quotes": [
                    {
                        "text": q.text,
                        "conversationId": q.conversation_id,
                        "location": q.location if isinstance(q.location, dict) else None,
                        "pole": "A" if q.id in pole_a_quotes else "B",
                    }
                    for q in tension.quotes
                ],
            },
            source_refs=[
                SourceRef(
                    conversation_id=q.conversation_id,
                    source_fingerprint=text_hashes.get(q.conversation_id),
                    quote=q.text,
                    location=q.location if isinstance(q.location, dict) else None,
                )
                for q in tension.quotes
            ],
            input_revision_ids=[s.revision_id for s in supporters],
            extra={"inputSet": input_set},
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
                        {
                            "text": q.text,
                            "conversationId": q.conversation_id,
                            "location": q.location if isinstance(q.location, dict) else None,
                        }
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


async def _done(result: StepResult) -> StepResult:
    return result


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Tensions",
    purpose=(
        "Find the tensions between saved arguments: two evidenced poles, the knot between them and "
        "the question to resolve, each pole linked to the exact arguments that hold it."
    ),
    input_types=("argument", "deduplicated_argument"),
    steps=RECIPE_STEPS,
    output_types=("tension",),
    execute=execute,
    dependencies=_on_arguments,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "reads one argument set, raw or deduplicated, never both",
        "every pole is held by at least one pinned argument whose evidence was found verbatim",
        "a verifier never supplies a side or a quote",
        "too little evidence is a valid result that suggests refreshing the arguments",
    ),
    identity_policy=IdentityPolicy(
        description="A tension keeps its identity while the same argument objects hold each of its poles."
    ),
    parameters_model=TensionsParameters,
    scope_key_pattern=re.compile(r"^project$"),
    model_config=model_deployment,
    model_concurrency=8,
    # Each judgement names its exact call, and the checks name the revisions
    # and sources they read, so an unchanged judgement is not asked again.
    partitioned_inputs=("sources", "revisionIds"),
)
