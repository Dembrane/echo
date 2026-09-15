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

Pure pipeline logic and model calls: persistence, identity and publication
belong to the shared executor.
"""

from __future__ import annotations

import re
import time
import asyncio
import hashlib
from typing import Any, Literal, Mapping, Sequence
from pathlib import Path
from dataclasses import field, asdict, replace, dataclass

from dembrane.popcorn import tensions as stages
from dembrane.popcorn.analysis import QuoteBook, norm

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
