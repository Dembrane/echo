"""Scripted transcripts and models for the producer recipes (no network).

`ProducerWorld` holds one project's transcripts, the extractor's answers per
conversation, the vector of each embedded text, a deduplication verifier and a
tensions judge, and counts every call. `world.deps(recorder)` hands them to the
executor as `ProducerServices`.

The default project has three conversations. Recording conversations is
argued for in the first and third and against in the second, so the judge
finds one tension between them; a pair of near-identical recording arguments
(20 degrees apart) is the one candidate group for deduplication, and the
night-trams statement is said identically in two conversations.
"""

from __future__ import annotations

import re
import math
import hashlib
from typing import Any, Callable
from collections import Counter
from dataclasses import replace

from dembrane.popcorn import tensions as stages
from dembrane.embedding import EmbeddingIdentity
from dembrane.map.recipe import Transcript
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import ExecutorDeps
from dembrane.analysis.recipes.services import SERVICES_KEY, ProducerServices
from dembrane.analysis.recipes.deduplication import VerificationRequest

PROJECT = "33333333-3333-4333-8333-333333333333"
C1 = "bbbbbbbb-0000-4000-8000-000000000001"
C2 = "bbbbbbbb-0000-4000-8000-000000000002"
C3 = "bbbbbbbb-0000-4000-8000-000000000003"

TOKENS = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}

TRAMS = "The city should add night trams on the main line."
PARKING = "Parking fees are too high for families."
RECORD = "Every conversation should be recorded."
RECORDINGS = "Recordings should be kept because notes miss what people meant."
OFF_RECORD = "Conversations should not go on a permanent record."
BRIDGE = "The bridge was built in 1932."
BUSES = "Night buses are cheaper to run than night trams."
MERGED_RECORD = "Conversations should be recorded so that what people meant is kept."

POLE_FOR = "Record the conversations"
POLE_AGAINST = "Keep talk off the record"


def item(statement: str, *evidence: str, kind: str = "argument", valence: str = "positive") -> dict[str, Any]:
    return {"kind": kind, "statement": statement, "evidence": list(evidence), "valence": valence}


def planar(degrees: float, dims: int) -> list[float]:
    """A unit vector in the plane of the first two axes: two of them have
    cosine similarity cos(difference)."""
    vector = [0.0] * dims
    vector[0] = math.cos(math.radians(degrees))
    vector[1] = math.sin(math.radians(degrees))
    return vector


def spread(text: str, dims: int) -> list[float]:
    """A deterministic vector with nothing on the first two axes, far from
    every planar vector and, in this many dimensions, from each other."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    values = [0.0, 0.0] + [(digest[i % len(digest)] / 255.0) * 2 - 1 for i in range(dims - 2)]
    return values if any(values) else [0.0, 0.0, 1.0, *values[3:]]


def for_recording(statement: str) -> bool:
    text = statement.casefold()
    return "record" in text and "permanent" not in text


def against_recording(statement: str) -> bool:
    return "permanent record" in statement.casefold()


def keep_apart(request: VerificationRequest) -> dict[str, Any]:
    return {
        "groups": [
            {
                "members": [member.label],
                "proposed_statement": "",
                "checks": [],
                "verdict": "not_equivalent",
                "rationale": "Stands apart.",
            }
            for member in request.members
        ]
    }


def merge_all(statement: str, *, refuse: set[str] | None = None) -> Callable[[VerificationRequest], dict[str, Any]]:
    """One equivalent sub-group of every member, each member checked
    equivalent unless its statement is in `refuse`."""

    def answer(request: VerificationRequest) -> dict[str, Any]:
        return {
            "groups": [
                {
                    "members": [m.label for m in request.members],
                    "proposed_statement": statement,
                    "checks": [
                        {
                            "member": m.label,
                            "judgement": "not_equivalent" if m.statement in (refuse or set()) else "equivalent",
                            "note": f"checked {m.label}",
                        }
                        for m in request.members
                    ],
                    "verdict": "equivalent",
                    "rationale": "The same position in other words.",
                }
            ]
        }

    return answer


class ProducerWorld:
    def __init__(self, *, dims: int = 64, model: str = "text-embedding-004") -> None:
        self.dims = dims
        self.model = model
        self.transcripts: list[Transcript] = []
        self.items: dict[str, list[dict[str, Any]]] = {}
        self.vectors: dict[str, list[float]] = {}
        self.extract_calls: Counter[str] = Counter()
        self.fail_extract: set[str] = set()
        self.embed_calls: list[str] = []
        self.probe_calls = 0
        self.verifier: Callable[[VerificationRequest], Any] = keep_apart
        self.verify_error: BaseException | None = None
        self.verify_calls: list[VerificationRequest] = []
        self.judge_calls: list[tuple[str, str]] = []
        # A stage whose every call raises.
        self.judge_errors: dict[str, BaseException] = {}
        self.deployment = {"group": "FAKE_GROUP", "model": "fake/model"}

    # ── the project ─────────────────────────────────────────────────────

    def add(self, conversation_id: str, label: str, text: str, items: list[dict[str, Any]], index: int) -> None:
        self.transcripts.append(
            Transcript(id=conversation_id, label=label, created_at=f"2026-09-1{index}T10:00:00Z", text=text)
        )
        self.items[conversation_id] = items

    def set_text(self, conversation_id: str, text: str, items: list[dict[str, Any]] | None = None) -> None:
        self.transcripts = [replace(t, text=text) if t.id == conversation_id else t for t in self.transcripts]
        if items is not None:
            self.items[conversation_id] = items

    @classmethod
    def recording_debate(cls) -> ProducerWorld:
        world = cls()
        world.add(
            C1,
            "Ann",
            "Ann: The city should add night trams on the main line.\n"
            "Ann: Parking fees are far too high for young families.\n"
            "Ann: Everything we say here should be recorded so nothing is lost.",
            [
                item(TRAMS, "The city should add night trams on the main line"),
                item(PARKING, "Parking fees are far too high for young families", valence="negative"),
                item(RECORD, "Everything we say here should be recorded so nothing is lost"),
                item("Cars should be banned.", "ban every car tomorrow"),
            ],
            1,
        )
        world.add(
            C2,
            "Bob",
            "Bob: we should add night trams on the main line, honestly.\n"
            "Bob: I would not speak freely if every word went on a permanent record.\n"
            "Bob: The old bridge was built in 1932 by the province.",
            [
                item(TRAMS, "we should add night trams on the main line"),
                item(OFF_RECORD, "I would not speak freely if every word went on a permanent record", valence="negative"),
                item(BRIDGE, "The old bridge was built in 1932", kind="claim", valence="neutral"),
            ],
            2,
        )
        world.add(
            C3,
            "Cas",
            "Cas: Buses are cheaper to run than trams at night.\n"
            "Cas: Keep the recordings, the notes never capture what people meant.",
            [
                item(BUSES, "Buses are cheaper to run than trams at night"),
                item(RECORDINGS, "Keep the recordings, the notes never capture what people meant"),
            ],
            3,
        )
        world.vectors[RECORD] = planar(0, world.dims)
        world.vectors[RECORDINGS] = planar(20, world.dims)
        return world

    # ── counters ────────────────────────────────────────────────────────

    def stage_calls(self, stage: str) -> int:
        return sum(1 for name, _user in self.judge_calls if name == stage)

    def model_calls(self) -> int:
        return sum(self.extract_calls.values()) + len(self.verify_calls) + len(self.judge_calls)

    def identity(self) -> EmbeddingIdentity:
        return EmbeddingIdentity(model=self.model, endpoint="fake:endpoint", dims=self.dims)

    # ── services ────────────────────────────────────────────────────────

    def services(self) -> ProducerServices:
        async def transcripts(project_id: str) -> list[Transcript]:
            return list(self.transcripts) if project_id == PROJECT else []

        async def extract(
            *, conversation_id: str, window: str, window_index: int, window_count: int  # noqa: ARG001
        ) -> tuple[dict[str, Any], dict[str, int]]:
            self.extract_calls[conversation_id] += 1
            if conversation_id in self.fail_extract:
                raise RuntimeError("the fake extractor broke")
            return {"items": [dict(i) for i in self.items.get(conversation_id, [])]}, dict(TOKENS)

        async def probe() -> EmbeddingIdentity:
            self.probe_calls += 1
            return self.identity()

        async def embed(text: str) -> list[float]:
            self.embed_calls.append(text)
            return list(self.vectors.get(text) or spread(text, self.dims))

        async def verify(request: VerificationRequest) -> tuple[Any, dict[str, int]]:
            self.verify_calls.append(request)
            if self.verify_error is not None:
                raise self.verify_error
            return self.verifier(request), {**TOKENS, "attempts": 1}

        async def generate(
            *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool = True  # noqa: ARG001
        ) -> tuple[dict[str, Any], dict[str, int]]:
            return self.judge(user_text, schema), dict(TOKENS)

        return ProducerServices(
            transcripts=transcripts,
            extract=extract,
            probe=probe,
            embed=embed,
            embedding_settings=lambda: {"model": self.model, "baseUrl": "fake:endpoint"},
            model_deployment=lambda: dict(self.deployment),
            verify=verify,
            generate=generate,
        )

    def deps(self, recorder: Recorder, *, dispatch: bool = True) -> ExecutorDeps:
        deps = recorder.deps(dispatch=dispatch)
        deps.services = {SERVICES_KEY: self.services()}
        return deps

    # ── the tensions judge ──────────────────────────────────────────────

    def judge(self, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        stage = next(name for known, name in _STAGES if schema is known)
        self.judge_calls.append((stage, user))
        if stage in self.judge_errors:
            raise self.judge_errors[stage]
        if stage == "framing":
            return {"handed": []}
        if stage == "collisions":
            listing = dict(re.findall(r"^(P\d+) \[[^\]]*\] (.*)$", user, re.MULTILINE))
            focal = user.rsplit("FOCAL POSITION: ", 1)[1].strip()
            mine = listing[focal]
            collides = [
                {"id": other, "why": "one pays for the other", "zero_sum": 0.9}
                for other, statement in listing.items()
                if other != focal
                and (
                    (for_recording(mine) and against_recording(statement))
                    or (against_recording(mine) and for_recording(statement))
                )
            ]
            return {"collides": collides}
        if stage == "verify":
            side_a = re.search(r"^A \([^)]*\): (.*)$", user, re.MULTILINE)
            a_for = bool(side_a and for_recording(side_a.group(1)))
            return {
                "valid": True,
                "why": "both are held",
                "poleA": POLE_FOR if a_for else POLE_AGAINST,
                "poleB": POLE_AGAINST if a_for else POLE_FOR,
                "quotesA": ["a line nobody said"],
                "quotesB": [],
            }
        if stage == "dedupe":
            kept = re.findall(r"^(x\d+): (.*) / (.*)$", user, re.MULTILINE)
            new = re.search(r"^NEW: (.*) / (.*)$", user, re.MULTILINE)
            assert new is not None
            for kept_id, pole_a, pole_b in kept:
                if {pole_a, pole_b} == {new.group(1), new.group(2)}:
                    return {"same_as": kept_id, "swapped": pole_a != new.group(1), "why": "the same pull"}
            return {"same_as": "", "swapped": False, "why": ""}
        return {
            "poleA": "",
            "poleB": "",
            "knot": "Record it and candour goes; keep it off and the memory goes.",
            "toResolve": "Which conversations go on the record?",
        }


_STAGES = (
    (stages.HANDED_SCHEMA, "framing"),
    (stages.COLLISIONS_SCHEMA, "collisions"),
    (stages.VERIFY_SCHEMA, "verify"),
    (stages.DEDUPE_SCHEMA, "dedupe"),
    (stages.WRITE_SCHEMA, "write"),
)
