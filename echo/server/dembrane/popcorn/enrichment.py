"""The second pass over a conversation's phrases: evidence and kind.

Ported from Dembrane/popcorn `tools/validate_popcorn.py` and
`tools/classify_popcorn.py` (commit 8c23eba). The fast pass writes phrases
without checking them, because latency is the point. Once they are on the
stage, each phrase gets two calls with its transcript in view:

- evidence (`popcorn-validate`): the verbatim passage the phrase paraphrases.
  The passage is checked word for word against the transcript by code; a
  passage that is not there is discarded and the phrase stays unrooted. A
  rooted phrase gets a `quoteId` and the deck draws it in quotation marks,
  clickable to the passage.
- kind (`popcorn-kind`): what the speaker was doing (eight kinds from
  `popcorn-ontology`), qualifiers that are stored and not drawn, and whether
  the phrase is a question in form. A question-kind phrase written as a
  statement is rewritten as the question that was asked (`popcorn-question`),
  gated by the same contract as the extractor.

The model's reasons and targets never reach a screen: they are kept on the
item under `review`, with the names from the introductions scrubbed, and the
bundle never emits `review`.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Awaitable

from dembrane.popcorn.flags import name_hits, scrub_names
from dembrane.popcorn.analysis import norm

KINDS = [
    "observation",
    "distinction",
    "need",
    "practice",
    "idea",
    "objection",
    "question",
    "decision",
]
QUALIFIERS = ["tentative", "personal_experience", "not_implemented"]

VALIDATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["grounded", "quote", "reason"],
    "properties": {
        "grounded": {"type": "boolean"},
        "quote": {"type": "string", "maxLength": 400},
        "reason": {"type": "string", "maxLength": 300},
    },
}
KIND_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["kind", "qualifiers", "question_form", "target", "reason"],
    "properties": {
        "kind": {"type": "string", "enum": KINDS},
        "qualifiers": {"type": "array", "items": {"type": "string", "enum": QUALIFIERS}},
        "question_form": {"type": "boolean"},
        "target": {"type": "string", "maxLength": 80},
        "reason": {"type": "string", "maxLength": 300},
    },
}
QUESTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["phrase"],
    "properties": {"phrase": {"type": "string", "maxLength": 90}},
}

MIN_QUOTE_CHARS = 12
MAX_PHRASE_CHARS = 90
MAX_PHRASE_WORDS = 13

# A modal the phrase carries that its source passage does not is a change of
# status: an experience reported as a possibility, "some" widened to "can".
HEDGE = re.compile(
    r"\b(can|could|may|might|tends? to|often|sometimes|typically|usually|potentially)\b",
    re.IGNORECASE,
)


def hedge_added(phrase: str, quote: str) -> list[str]:
    """Hedges in the phrase that the source passage does not carry."""
    return sorted(
        {m.lower() for m in HEDGE.findall(phrase)} - {m.lower() for m in HEDGE.findall(quote)}
    )


def evidence_from(raw: dict[str, Any], phrase: str, transcript: str) -> dict[str, Any]:
    """Shape one validate response: the quote counts only when it is verbatim."""
    quote = str(raw.get("quote") or "").strip()
    verbatim = len(quote) >= MIN_QUOTE_CHARS and norm(quote) in norm(transcript)
    grounded = bool(raw.get("grounded")) and verbatim
    return {
        "grounded": grounded,
        "quote": quote if grounded else "",
        "hedge_added": hedge_added(phrase, quote) if grounded else [],
        "reason": str(raw.get("reason") or "").strip(),
    }


def kind_from(raw: dict[str, Any], names: set[str]) -> dict[str, Any]:
    """Shape one kind response; anything that could reach a screen is scrubbed."""
    kind = str(raw.get("kind") or "")
    if kind not in KINDS:
        raise ValueError(f"unknown popcorn kind {kind!r}")
    qualifiers = [q for q in (raw.get("qualifiers") or []) if q in QUALIFIERS]
    return {
        "kind": kind,
        "qualifiers": qualifiers,
        "question": bool(raw.get("question_form")),
        "target": scrub_names(str(raw.get("target") or ""), names),
        "reason": scrub_names(str(raw.get("reason") or ""), names),
    }


def question_ok(phrase: str) -> bool:
    """The rewrite has to pass the extractor's own contract, plus the mark."""
    return (
        phrase.endswith("?")
        and len(phrase) <= MAX_PHRASE_CHARS
        and len(phrase.split()) <= MAX_PHRASE_WORDS
        and '"' not in phrase
        and "\n" not in phrase
    )


Call = Callable[..., Awaitable[dict[str, Any]]]


async def enrich_item(
    item: dict[str, Any],
    *,
    transcript_id: str,
    transcript: str,
    names: set[str],
    validate: Call,
    classify: Call,
    rewrite: Call,
) -> dict[str, Any]:
    """Both calls for one phrase, each failure kept on its own so the other
    still lands. Returns a result record; nothing is applied here."""
    phrase = str(item.get("phrase") or "")
    result: dict[str, Any] = {"id": item.get("id"), "phrase": phrase, "errors": []}
    try:
        raw = await validate(transcript_id=transcript_id, transcript=transcript, phrase=phrase)
        result["evidence"] = evidence_from(raw, phrase, transcript)
    except Exception as exc:  # one dead call must not cost the phrase its kind
        result["errors"].append(f"evidence: {str(exc)[:200]}")
    try:
        raw = await classify(transcript_id=transcript_id, transcript=transcript, phrase=phrase)
        kind = kind_from(raw, names)
        if kind["kind"] == "question" and not kind["question"]:
            try:
                out = await rewrite(
                    transcript_id=transcript_id, transcript=transcript, phrase=phrase
                )
                candidate = str(out.get("phrase") or "").strip()
                if question_ok(candidate) and not name_hits(candidate, names):
                    result["rewritten"] = candidate[:-1].rstrip()
                    kind["question"] = True
            except Exception as exc:
                result["errors"].append(f"question: {str(exc)[:200]}")
        result["kind"] = kind
    except Exception as exc:
        result["errors"].append(f"kind: {str(exc)[:200]}")
    return result


def apply_results(
    items: list[dict[str, Any]],
    results: list[dict[str, Any]],
    *,
    transcript_id: str,
    register: Callable[[str, str], str | None],
) -> dict[str, int]:
    """Write the results onto the items, in place, once. `register(tid, text)`
    puts a verified passage in the quote registry and returns its id."""
    by_id = {str(r.get("id")): r for r in results}
    rooted = classified = rewritten = 0
    for item in items:
        r = by_id.get(str(item.get("id")))
        if r is None or r.get("phrase") != item.get("phrase"):
            continue  # the phrase changed under the pass; leave it for the next tick
        review: dict[str, Any] = dict(item.get("review") or {})
        evidence = r.get("evidence")
        if evidence is not None:
            if evidence["grounded"] and evidence["quote"]:
                qid = register(transcript_id, evidence["quote"])
                if qid:
                    item["quoteId"] = qid
                    rooted += 1
                else:
                    item.pop("quoteId", None)
            else:
                item.pop("quoteId", None)
            review["evidence"] = evidence["reason"]
            if evidence["hedge_added"]:
                review["hedge_added"] = evidence["hedge_added"]
        kind = r.get("kind")
        if kind is not None:
            item["kind"] = kind["kind"]
            item["question"] = kind["question"]
            item["qualifiers"] = kind["qualifiers"]
            review["kind"] = kind["reason"]
            if kind["target"]:
                review["target"] = kind["target"]
            classified += 1
            if r.get("rewritten"):
                review["was"] = item["phrase"]
                item["phrase"] = r["rewritten"]
                rewritten += 1
        if r.get("errors"):
            review["errors"] = list(r["errors"])
        else:
            review.pop("errors", None)  # a retry that landed clears the old failure
        if review:
            item["review"] = review
    return {"rooted": rooted, "classified": classified, "rewritten": rewritten}
