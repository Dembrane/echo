"""Map's recipe, the pure half: grounding, consolidation and the manifest.

Read transcripts, extract distinct source-grounded arguments and claims,
consolidate equivalent statements while keeping all their evidence, embed the
complete statements, and save a manifest the renderers read. Nothing here calls
a model or a database; `generate.py` wires these steps to both.
"""

from __future__ import annotations

import math
import hashlib
from typing import Any, Iterable
from dataclasses import field, dataclass

# What a saved extraction and manifest mean, and so which failed attempts may
# resume. A prompt revision that leaves saved extractions valid keeps it.
RECIPE_VERSION = "map-arguments-v1"
MANIFEST_VERSION = 1

# Extraction reads a conversation in windows of this size, split on line
# breaks, with a little overlap so an argument that straddles a boundary is
# seen whole in one of them.
WINDOW_CHARS = 60_000
WINDOW_OVERLAP_CHARS = 2_000

MAX_QUOTES_PER_ITEM = 5
KINDS = ("argument", "claim")
VALENCES = ("positive", "negative", "neutral")

# Cosine similarity at or above which two statements with the same kind and
# valence count as the same statement. A property of the embedding model, not
# of the data. text-embedding-004 was calibrated on September 14th 2026 (its
# near-duplicates sat at 0.81 to 0.82, the median pair at 0.59); the browser
# prototype merged gemini-embedding-001 at 0.92. An unknown model merges only
# identical statements until someone calibrates it.
MERGE_SIMILARITY_BY_MODEL: dict[str, float] = {
    "text-embedding-004": 0.80,
    "gemini-embedding-001": 0.92,
}


def merge_threshold_for(model: str) -> float | None:
    name = model.rsplit("/", 1)[-1]
    return MERGE_SIMILARITY_BY_MODEL.get(name)


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").split())


def norm_key(text: str) -> str:
    return normalize_text(text).casefold()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Transcript:
    id: str
    label: str
    created_at: str | None
    text: str

    @property
    def text_hash(self) -> str:
        return sha256_hex(self.text)


def source_fingerprint(transcripts: Iterable[Transcript]) -> str:
    """What a result was generated from: every conversation and its exact text."""
    parts = sorted(f"{t.id}\x1f{t.text_hash}" for t in transcripts)
    return sha256_hex("\x1e".join(parts))


def transcript_windows(
    text: str, limit: int = WINDOW_CHARS, overlap: int = WINDOW_OVERLAP_CHARS
) -> list[str]:
    """Split on line breaks into windows of at most `limit` characters.

    A single line longer than the limit is cut hard. Consecutive windows share
    up to `overlap` characters of trailing lines."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    lines: list[str] = []
    for line in text.split("\n"):
        while len(line) > limit:
            lines.append(line[:limit])
            line = line[limit:]
        lines.append(line)
    windows: list[str] = []
    current: list[str] = []
    size = 0
    for line in lines:
        added = len(line) + (1 if current else 0)
        if current and size + added > limit:
            windows.append("\n".join(current))
            carry: list[str] = []
            carry_size = 0
            for previous in reversed(current):
                if carry_size + len(previous) + 1 > overlap:
                    break
                carry.insert(0, previous)
                carry_size += len(previous) + 1
            current, size = carry, max(0, carry_size - 1)
            # The carried overlap must still leave room for this line.
            while current and size + len(line) + 1 > limit:
                gone = current.pop(0)
                size = max(0, size - len(gone) - 1)
            added = len(line) + (1 if current else 0)
        current.append(line)
        size += added
    if current:
        windows.append("\n".join(current))
    return windows


_QUOTE_EDGES = "\"'“”‘’«»„ "
_ELLIPSES = ("...", "…")
_MIN_FRAGMENT_CHARS = 12


def ground_quote(quote: str, transcript_key: str) -> str | None:
    """The quote, whitespace-normalised, when it appears verbatim in the
    transcript (compared case-insensitively over collapsed whitespace).

    A quote the model shortened with an ellipsis is accepted when every
    fragment of at least twelve characters appears verbatim, in order."""
    text = normalize_text(quote).strip(_QUOTE_EDGES)
    if not text:
        return None
    key = text.casefold()
    if key in transcript_key:
        return text
    marker = next((m for m in _ELLIPSES if m in key), None)
    if marker is None:
        return None
    fragments = [f.strip(_QUOTE_EDGES) for f in key.replace("…", "...").split("...")]
    fragments = [f for f in fragments if f]
    if not fragments or any(len(f) < _MIN_FRAGMENT_CHARS for f in fragments):
        return None
    position = 0
    for fragment in fragments:
        found = transcript_key.find(fragment, position)
        if found < 0:
            return None
        position = found + len(fragment)
    return text


def candidate_id(conversation_id: str, statement: str, kind: str) -> str:
    return "c-" + sha256_hex(f"{conversation_id}\x1f{kind}\x1f{norm_key(statement)}")[:20]


def shape_extraction(
    raw: Any, transcript: Transcript, *, window_index: int = 0
) -> tuple[list[dict[str, Any]], int]:
    """Validate one extractor answer against its transcript.

    Keeps items with a statement, a known kind and valence, and at least one
    verbatim quote. Returns the candidates and how many items were dropped."""
    transcript_key = norm_key(transcript.text)
    values = raw.get("items") if isinstance(raw, dict) else None
    candidates: list[dict[str, Any]] = []
    dropped = 0
    for index, value in enumerate(values if isinstance(values, list) else []):
        if not isinstance(value, dict):
            dropped += 1
            continue
        statement = normalize_text(value.get("statement") or "")
        kind = value.get("kind")
        valence = value.get("valence")
        if not statement or kind not in KINDS or valence not in VALENCES:
            dropped += 1
            continue
        quotes: list[str] = []
        seen: set[str] = set()
        evidence = value.get("evidence")
        for quote in evidence if isinstance(evidence, list) else []:
            grounded = ground_quote(str(quote or ""), transcript_key)
            if grounded and grounded.casefold() not in seen:
                seen.add(grounded.casefold())
                quotes.append(grounded)
            if len(quotes) == MAX_QUOTES_PER_ITEM:
                break
        if not quotes:
            dropped += 1
            continue
        candidates.append(
            {
                "id": candidate_id(transcript.id, statement, kind),
                "conversation_id": transcript.id,
                "statement": statement,
                "kind": kind,
                "valence": valence,
                "quotes": quotes,
                "order": [window_index, index],
            }
        )
    return candidates, dropped


def merge_conversation_candidates(
    windows: list[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """One conversation's candidates across windows: the same statement seen in
    two overlapping windows is one candidate with the union of its quotes."""
    merged: dict[str, dict[str, Any]] = {}
    for window in windows:
        for candidate in window:
            existing = merged.get(candidate["id"])
            if existing is not None and existing["valence"] != candidate["valence"]:
                # Same words, different attitude: keep them apart, under the
                # whole valence (negative and neutral share a first letter).
                candidate = {**candidate, "id": f"{candidate['id']}-{candidate['valence']}"}
                existing = merged.get(candidate["id"])
            if existing is None:
                merged[candidate["id"]] = {**candidate, "quotes": list(candidate["quotes"])}
                continue
            known = {q.casefold() for q in existing["quotes"]}
            for quote in candidate["quotes"]:
                if quote.casefold() not in known and len(existing["quotes"]) < MAX_QUOTES_PER_ITEM:
                    existing["quotes"].append(quote)
                    known.add(quote.casefold())
    return sorted(merged.values(), key=lambda c: tuple(c["order"]))


def embedding_input(statement: str) -> str:
    """Exactly the text that is embedded for a statement."""
    return normalize_text(statement)


def input_hash(statement: str) -> str:
    return sha256_hex(embedding_input(statement))


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    denom = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b, strict=True)) / denom if denom else 0.0


class InvalidVector(ValueError):
    pass


def validate_vector(values: Any, dims: int) -> list[float]:
    """A finite, nonzero vector of exactly `dims` floats, or InvalidVector."""
    if not isinstance(values, (list, tuple)):
        raise InvalidVector("embedding is not a list")
    if len(values) != dims:
        raise InvalidVector(f"embedding has {len(values)} dimensions, expected {dims}")
    vector: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise InvalidVector("embedding has a non-numeric value") from exc
        if not math.isfinite(number):
            raise InvalidVector("embedding has a non-finite value")
        vector.append(number)
    if not any(vector):
        raise InvalidVector("embedding is the zero vector")
    return vector


@dataclass
class _Groups:
    members: list[list[int]]
    owner: list[int] = field(default_factory=list)

    @classmethod
    def singletons(cls, size: int) -> _Groups:
        return cls(members=[[i] for i in range(size)], owner=list(range(size)))

    def join(self, a: int, b: int) -> None:
        ga, gb = self.owner[a], self.owner[b]
        if ga == gb:
            return
        keep, gone = min(ga, gb), max(ga, gb)
        for member in self.members[gone]:
            self.owner[member] = keep
        self.members[keep].extend(self.members[gone])
        self.members[gone] = []


def consolidate(
    candidates: list[dict[str, Any]],
    vectors: dict[str, list[float]],
    threshold: float | None,
) -> list[list[dict[str, Any]]]:
    """Group candidates that make the same statement.

    Two candidates may share a group only with the same kind and valence, so a
    position and its opposite never collapse into one node. Identical
    statements group; with a threshold, statements group by complete linkage:
    every pair across the two groups must reach the threshold, which stops a
    chain of small steps from joining unrelated positions. `vectors` is keyed
    by `input_hash(statement)`."""
    import numpy as np

    count = len(candidates)
    groups = _Groups.singletons(count)
    if count == 0:
        return []
    keys = np.array([norm_key(c["statement"]) for c in candidates], dtype=object)
    kinds = np.array([c["kind"] for c in candidates], dtype=object)
    valences = np.array([c["valence"] for c in candidates], dtype=object)
    compatible = (kinds[:, None] == kinds[None, :]) & (valences[:, None] == valences[None, :])
    same_key = keys[:, None] == keys[None, :]
    upper = np.triu(np.ones((count, count), dtype=bool), k=1)
    for i, j in zip(*np.nonzero(compatible & same_key & upper), strict=True):
        groups.join(int(i), int(j))

    if threshold is not None and count > 1:
        hashes = [input_hash(c["statement"]) for c in candidates]
        dims = next((len(vectors[h]) for h in hashes if h in vectors), 0)
        matrix = np.zeros((count, max(dims, 1)))
        for index, hashed in enumerate(hashes):
            vector = vectors.get(hashed)
            if vector is not None and len(vector) == dims:
                matrix[index] = vector
        norms = np.linalg.norm(matrix, axis=1)
        norms[norms == 0] = 1.0
        unit = matrix / norms[:, None]
        similarity = unit @ unit.T
        # A missing vector has a zero row, so it matches nothing.
        joinable = (similarity >= threshold) | same_key
        rows, cols = np.nonzero(compatible & upper & (similarity >= threshold))
        order = sorted(
            zip(rows.tolist(), cols.tolist(), strict=True),
            key=lambda pair: (-float(similarity[pair[0], pair[1]]), pair[0], pair[1]),
        )
        for i, j in order:
            gi, gj = groups.owner[i], groups.owner[j]
            if gi == gj:
                continue
            if bool(np.all(joinable[np.ix_(groups.members[gi], groups.members[gj])])):
                groups.join(i, j)

    ordered = [
        [candidates[index] for index in sorted(members)]
        for members in groups.members
        if members
    ]
    ordered.sort(key=lambda group: min(_candidate_order(c) for c in group))
    return ordered


def _candidate_order(candidate: dict[str, Any]) -> tuple[int, int, int]:
    rank = candidate.get("conversation_rank", 0)
    order = candidate.get("order") or [0, 0]
    return (int(rank), int(order[0]), int(order[1]))


def representative(group: list[dict[str, Any]]) -> dict[str, Any]:
    """The statement a node shows and embeds: the best-evidenced candidate,
    earliest on a tie. It is never rewritten, so its vector already exists."""
    return sorted(group, key=lambda c: (-len(c["quotes"]), _candidate_order(c)))[0]


def claim_key(statement: str, quotes: Iterable[str]) -> str:
    """A claim revision: its statement and the evidence it was checked with."""
    evidence = "\x1f".join(sorted({norm_key(q) for q in quotes}))
    return sha256_hex(f"{norm_key(statement)}\x1e{evidence}")


def node_id(statement: str, kind: str) -> str:
    return "a-" + sha256_hex(f"{kind}\x1f{norm_key(statement)}")[:20]


def build_manifest(
    groups: list[list[dict[str, Any]]],
    transcripts: list[Transcript],
    embedding_ids: dict[str, str],
    *,
    stats: dict[str, Any],
    consolidation: dict[str, Any],
) -> dict[str, Any]:
    """The saved result: every argument with its evidence and its embedding.

    `embedding_ids` maps `input_hash` to a persisted `map_embedding` id; a
    representative without one is a programming error, never a silent drop."""
    by_id = {t.id: t for t in transcripts}
    arguments: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for group in groups:
        head = representative(group)
        evidence_by_conversation: dict[str, list[str]] = {}
        for candidate in group:
            quotes = evidence_by_conversation.setdefault(candidate["conversation_id"], [])
            known = {q.casefold() for q in quotes}
            for quote in candidate["quotes"]:
                if quote.casefold() not in known:
                    quotes.append(quote)
                    known.add(quote.casefold())
        evidence = []
        for conversation_id, quotes in evidence_by_conversation.items():
            transcript = by_id.get(conversation_id)
            evidence.append(
                {
                    "conversation_id": conversation_id,
                    "label": transcript.label if transcript else "",
                    "created_at": transcript.created_at if transcript else None,
                    "quotes": quotes,
                }
            )
        hashed = input_hash(head["statement"])
        embedding_id = embedding_ids.get(hashed)
        if not embedding_id:
            raise KeyError(f"no persisted embedding for argument {head['id']}")
        identifier = node_id(head["statement"], head["kind"])
        if identifier in used_ids:
            # The same words with another attitude: consolidation kept them apart.
            identifier = f"{identifier}-{head['valence']}"
        if identifier in used_ids:
            raise ValueError(f"two arguments share the id {identifier}")
        used_ids.add(identifier)
        all_quotes = [q for quotes in evidence_by_conversation.values() for q in quotes]
        created = [item["created_at"] for item in evidence if item["created_at"]]
        arguments.append(
            {
                "id": identifier,
                "statement": head["statement"],
                "kind": head["kind"],
                "valence": head["valence"],
                "claim_key": claim_key(head["statement"], all_quotes)
                if head["kind"] == "claim"
                else None,
                "evidence": evidence,
                "created_at": max(created) if created else None,
                "input_hash": hashed,
                "embedding_id": embedding_id,
                "candidate_ids": [c["id"] for c in group],
            }
        )
    return {
        "version": MANIFEST_VERSION,
        "recipe_version": RECIPE_VERSION,
        "arguments": arguments,
        "conversations": [
            {"id": t.id, "label": t.label, "created_at": t.created_at} for t in transcripts
        ],
        "consolidation": consolidation,
        "stats": stats,
    }


# ── selection titles ────────────────────────────────────────────────────

MIN_TITLE_NODES = 3
# The whole selection goes to the model or none of it: a selection larger than
# this is refused rather than summarised in part. 120,000 characters is far
# above a full map at the working scale (200 arguments of a few sentences).
MAX_TITLE_CHARS = 120_000


class SelectionTooSmall(ValueError):
    pass


class SelectionTooLarge(ValueError):
    pass


def title_selection_key(result_id: str, node_ids: Iterable[str], config: str) -> str:
    ids = "\x1f".join(sorted(set(node_ids)))
    return sha256_hex(f"{result_id}\x1e{ids}\x1e{config}")


def title_lines(
    arguments: list[dict[str, Any]], verdicts: dict[str, str | None]
) -> list[str]:
    """One tagged line per selected argument, in the order given.

    `verdicts` maps claim keys to a finished verdict; a claim without one is
    unverified, as the prototype sent it."""
    lines = []
    for index, argument in enumerate(arguments, start=1):
        if argument["kind"] == "claim":
            verdict = verdicts.get(argument.get("claim_key") or "") or "unverified"
            tag = f"[claim, {verdict}]"
        else:
            tag = "[argument]"
        lines.append(f"{index}. {tag} {argument['statement']}")
    total = sum(len(line) + 1 for line in lines)
    if len(lines) < MIN_TITLE_NODES:
        raise SelectionTooSmall(f"a title needs at least {MIN_TITLE_NODES} arguments")
    if total > MAX_TITLE_CHARS:
        raise SelectionTooLarge(
            f"the selection is {total} characters; the limit is {MAX_TITLE_CHARS}"
        )
    return lines
