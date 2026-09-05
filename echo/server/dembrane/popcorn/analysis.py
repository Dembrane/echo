"""Popcorn contracts and the cross-conversation slides (tensions, stakeholders).

Ported from Dembrane/popcorn `tools/analysis.py` (commit 7c3d1cf, gates and
the quote context rule from 8c23eba) so the in-app pipeline shapes output
exactly the way the presentation expects.

Popcorn is per conversation and fast. Tensions and stakeholders read the
whole session at once and arrive later, which is what the deck expects. Both
are grounded the same way: the model returns the quotes it relied on, every
quote is checked verbatim against the source before anything is written, and
whatever fails the check is dropped along with the aspects resting on it.
"""

from __future__ import annotations

import re
import hashlib
from typing import Any

# The public popcorn contract: at most eight phrases, each short, weighted 1-3.
POPCORN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["phrase", "weight"],
                "properties": {
                    "phrase": {"type": "string", "minLength": 1, "maxLength": 90},
                    "weight": {"type": "integer", "minimum": 1, "maximum": 3},
                },
            },
        }
    },
}

QUOTE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["transcript", "text"],
    "properties": {
        "transcript": {"type": "string"},
        "text": {"type": "string", "minLength": 12, "maxLength": 400},
        "context": {"type": "string", "maxLength": 200},
    },
}

TENSIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["tensions"],
    "properties": {
        "tensions": {
            "type": "array",
            "maxItems": 6,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["poleA", "poleB", "narrative", "toResolve", "quotes"],
                "properties": {
                    "poleA": {"type": "string", "minLength": 3, "maxLength": 60},
                    "poleB": {"type": "string", "minLength": 3, "maxLength": 60},
                    "narrative": {"type": "string", "minLength": 40, "maxLength": 700},
                    "toResolve": {"type": "string", "minLength": 10, "maxLength": 300},
                    "quotes": {"type": "array", "maxItems": 4, "items": QUOTE},
                },
            },
        }
    },
}

# Vertex rejects this schema outright when it carries maxItems at these nesting
# depths (HTTP 400 INVALID_ARGUMENT; the flatter tensions schema takes it fine).
# The caps are enforced in shape_stakeholders instead.
MAX_STAKEHOLDERS, MAX_RELATIONS, MAX_ASPECTS, MAX_QUOTES = 9, 12, 3, 3

STAKEHOLDERS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stakeholders", "relations"],
    "properties": {
        "stakeholders": {
            "type": "array",
            "minItems": 2,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    "role",
                    "stake",
                    "rung",
                    "stakeWeight",
                    "mentionsWeight",
                    "quotes",
                ],
                "properties": {
                    "name": {"type": "string", "minLength": 2, "maxLength": 48},
                    "role": {"type": "string", "minLength": 5, "maxLength": 160},
                    "stake": {"type": "string", "minLength": 5, "maxLength": 200},
                    "rung": {"type": "string", "enum": ["voiced", "named", "inferred"]},
                    "invokedBy": {"type": "string", "maxLength": 48},
                    "stakeWeight": {"type": "number", "minimum": 0, "maximum": 1},
                    "mentionsWeight": {"type": "number", "minimum": 0, "maximum": 1},
                    "quotes": {"type": "array", "items": QUOTE},
                },
            },
        },
        "relations": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "between",
                    "label",
                    "intensity",
                    "sentiment",
                    "unowned",
                    "detail",
                    "aspects",
                ],
                "properties": {
                    "between": {
                        "type": "array",
                        "minItems": 2,
                        "items": {"type": "string", "maxLength": 48},
                    },
                    "label": {"type": "string", "minLength": 3, "maxLength": 70},
                    "intensity": {"type": "number", "minimum": 0, "maximum": 1},
                    "sentiment": {"type": "number", "minimum": -1, "maximum": 1},
                    "unowned": {"type": "boolean"},
                    "detail": {"type": "string", "minLength": 20, "maxLength": 500},
                    "aspects": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["kind", "note", "quotes"],
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["power", "risk", "opportunity"],
                                },
                                "note": {"type": "string", "minLength": 10, "maxLength": 300},
                                "quotes": {"type": "array", "minItems": 1, "items": QUOTE},
                            },
                        },
                    },
                },
            },
        },
    },
}


# The prompt asks for twelve words; the gate tolerates thirteen on purpose
# (upstream measured bloat beginning at fourteen).
MAX_PHRASE_WORDS = 13
MAX_PHRASE_CHARS = 90

# A quote's context may say where in the conversation the moment sits, never
# who said it: the transcripts have no speaker labels, so a pronoun or a name
# here is a guess about a real person.
ATTRIBUTES = re.compile(
    r"\b(he|she|him|her|his|hers|himself|herself|introducing (him|her)self)\b", re.IGNORECASE
)
# ...and a proper noun after the first word is a person or an organisation,
# which is the same guess in a different costume. "AI" is the one capital that
# is neither.
PROPER = re.compile(r"(?<!^)(?<![.!?]\s)\b(?!AI\b)[A-Z][a-z]+")


def attributes(context: str) -> bool:
    """True when a context line assigns a speaker: a pronoun, a name, an organisation."""
    return bool(ATTRIBUTES.search(context) or PROPER.search(context.strip()))


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def build_corpus(transcripts: list[tuple[str, str]]) -> str:
    """One prompt-sized document, each transcript announced by its id."""
    parts = []
    for tid, text in transcripts:
        parts.append(f"TRANSCRIPT id: {tid}\n{text}\nEND TRANSCRIPT {tid}")
    return "\n\n".join(parts)


def shape_popcorn_items(raw: dict[str, Any] | None, transcript_id: str) -> list[dict[str, Any]]:
    """Apply the deterministic first-run gates to one extractor response.

    Anything the schema cannot express (unique phrases, one weight-3 item, at
    most thirteen words, no quotation marks or terminal punctuation) is
    enforced here so a slip never reaches the screen. The one mark that
    survives is a question mark: a phrase in question form keeps `question`
    true and the deck draws the mark back. Near-duplicates, names and text the
    room was shown are the tick's business (`flags.gate_items`), because they
    need the transcript and the previous state.
    """
    items = raw.get("items") if isinstance(raw, dict) else None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    weight3_used = False
    for item in items or []:
        if not isinstance(item, dict):
            continue
        phrase = re.sub(r"\s+", " ", str(item.get("phrase") or "")).strip()
        phrase = phrase.strip("\"'“”‘’").strip()
        question = phrase.endswith("?")
        phrase = phrase.rstrip(".!?;:").strip()
        if not phrase or len(phrase) > MAX_PHRASE_CHARS or len(phrase.split()) > MAX_PHRASE_WORDS:
            continue
        if '"' in phrase or "“" in phrase or "”" in phrase:
            continue
        key = norm(phrase)
        if key in seen:
            continue
        seen.add(key)
        try:
            weight = int(item.get("weight") or 1)
        except (TypeError, ValueError):
            weight = 1
        weight = max(1, min(3, weight))
        if weight == 3:
            if weight3_used:
                weight = 2
            weight3_used = True
        # The id follows the phrase text, not its position: a later re-read of a
        # growing transcript keeps the same id for a phrase it returns again, so
        # the stage does not pop it a second time.
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
        entry: dict[str, Any] = {
            "id": f"p-{transcript_id}-{digest}",
            "phrase": phrase,
            "weight": weight,
        }
        if question:
            entry["question"] = True
        out.append(entry)
        if len(out) >= 8:
            break
    return out


class QuoteBook:
    """Assigns quote ids, and refuses any quote that is not verbatim.

    One book serves a whole tick: it is seeded with the registry the session
    already has, so ids the deck holds stay valid, and every pass (the popcorn
    second pass, then tensions and stakeholders) registers into the same one.
    A seeded quote whose transcript is gone is dropped with the transcript.
    """

    def __init__(
        self,
        sources: dict[str, str],
        *,
        names: set[str] | None = None,
        existing: list[dict[str, Any]] | None = None,
    ):
        self.norm_sources = {tid: norm(t) for tid, t in sources.items()}
        self.names = set(names or ())
        self.quotes: list[dict[str, Any]] = []
        self._seen: dict[tuple[str, str], str] = {}
        self.rejected = 0
        self._next = 1
        for q in existing or []:
            if not isinstance(q, dict):
                continue
            m = re.fullmatch(r"q(\d+)", str(q.get("id") or ""))
            text = str(q.get("text") or "").strip()
            key = norm(text)
            tid = str(q.get("transcript") or "")
            if (
                not m
                or not text
                or (tid, key) in self._seen
                or key not in self.norm_sources.get(tid, "")
            ):
                continue
            entry = {"id": q["id"], "transcript": tid, "text": text}
            ctx = self._safe_context(q.get("context"))
            if ctx:
                entry["context"] = ctx
            self.quotes.append(entry)
            self._seen[(tid, key)] = q["id"]
            self._next = max(self._next, int(m.group(1)) + 1)

    def _safe_context(self, raw: Any) -> str:
        """A context line that says where the moment sits, never who spoke:
        the transcripts carry no speakers, so one that assigns a speaker is
        dropped, whether it arrives new or seeded from an older registry."""
        ctx = str(raw or "").strip()
        if not ctx or attributes(ctx):
            return ""
        if any(re.search(rf"\b{re.escape(n)}\b", ctx) for n in self.names):
            return ""
        return ctx

    def add(self, q: dict[str, Any]) -> str | None:
        text = str(q.get("text") or "").strip()
        if not text:
            return None
        key = norm(text)
        tid = str(q.get("transcript") or "")
        found_in = tid if key in self.norm_sources.get(tid, "") else None
        if found_in is None:  # model may misattribute; accept if it exists anywhere
            for cand, body in self.norm_sources.items():
                if key in body:
                    found_in = cand
                    break
        if found_in is None:
            self.rejected += 1
            return None
        # The same words said at two tables are two quotes: one per conversation.
        if (found_in, key) in self._seen:
            return self._seen[(found_in, key)]
        qid = f"q{self._next}"
        self._next += 1
        entry: dict[str, Any] = {"id": qid, "transcript": found_in, "text": text}
        ctx = self._safe_context(q.get("context"))
        if ctx:
            entry["context"] = ctx
        self.quotes.append(entry)
        self._seen[(found_in, key)] = qid
        return qid

    def add_all(self, qs: Any) -> list[str]:
        return [qid for qid in (self.add(q) for q in (qs or []) if isinstance(q, dict)) if qid]

    def payload(self) -> dict[str, Any]:
        return {"quotes": self.quotes}


def shape_tensions(raw: dict[str, Any], book: QuoteBook) -> dict[str, Any]:
    out = []
    for n, t in enumerate(raw.get("tensions") or [], 1):
        out.append(
            {
                "id": f"x{n}",
                "poleA": t["poleA"],
                "poleB": t["poleB"],
                "narrative": t["narrative"],
                "toResolve": t["toResolve"],
                "quoteIds": book.add_all(t.get("quotes")),
            }
        )
    return {"tensions": out}


def shape_stakeholders(raw: dict[str, Any], book: QuoteBook) -> dict[str, Any]:
    people: list[dict[str, Any]] = []
    by_name: dict[str, str] = {}
    for n, s in enumerate((raw.get("stakeholders") or [])[:MAX_STAKEHOLDERS], 1):
        sid = f"s{n}"
        by_name[norm(s["name"])] = sid
        ev: dict[str, Any] = {"rung": s["rung"]}
        if s.get("invokedBy"):
            ev["invokedBy"] = s["invokedBy"]
        people.append(
            {
                "id": sid,
                "name": s["name"],
                "role": s["role"],
                "stake": s["stake"],
                "quoteIds": book.add_all((s.get("quotes") or [])[:MAX_QUOTES]),
                "evidence": ev,
                "weight": {
                    "stake": round(float(s["stakeWeight"]), 2),
                    "mentions": round(float(s["mentionsWeight"]), 2),
                },
            }
        )

    relations: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, ...]] = set()
    for r in raw.get("relations") or []:
        if len(r.get("between") or []) != 2 or len(relations) >= MAX_RELATIONS:
            continue
        ids = [by_name.get(norm(nm)) for nm in r["between"]]
        if None in ids or ids[0] == ids[1]:
            continue  # a relation to nobody is not a relation
        pair = tuple(sorted(str(i) for i in ids))
        if pair in seen_pairs:
            continue  # authored once, for both groups
        seen_pairs.add(pair)
        aspects = []
        for a in (r.get("aspects") or [])[:MAX_ASPECTS]:
            qids = book.add_all((a.get("quotes") or [])[:MAX_QUOTES])
            if not qids:
                continue  # no quote, no aspect
            aspects.append({"kind": a["kind"], "note": a["note"], "quoteIds": qids})
        relations.append(
            {
                "id": f"r{len(relations) + 1}",
                "between": list(ids),
                "label": r["label"],
                "intensity": round(float(r["intensity"]), 2),
                "sentiment": round(float(r["sentiment"]), 2),
                "unowned": bool(r["unowned"]),
                "detail": r["detail"],
                "aspects": aspects,
            }
        )
    return {"stakeholders": people, "relations": relations}
