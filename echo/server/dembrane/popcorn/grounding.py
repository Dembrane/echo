"""Deterministic grounding for popcorn phrases.

Two questions, both answered by code rather than a model:

- Is the phrase verbatim in its transcript? Then it earns a quote in the
  registry and the deck shows it in quotation marks, per the upstream
  contract (`quoteId`, `validated`).
- If not, which passage did it most likely come from? The host sees that
  passage as "why this phrase". This is the rarity-weighted word overlap from
  upstream `tools/review_popcorn.html`: a reading aid, never a citation, so
  the room never sees it.

Upstream's model-judged validation pass (popcorn-validate) does not exist
yet; when it lands it slots in above this, not instead of it.
"""

from __future__ import annotations

import re
from typing import Any

from dembrane.popcorn.analysis import norm

# Copied from upstream review_popcorn.html, so hosts see the same matches the
# facilitator saw while calibrating the prompt.
STOP = set(
    "a an the and or but of to in on for with at by from as is are was were be been being it "
    "its this that these those we you they he she i not no do does did can could should would "
    "will shall may might must have has had there their them our your his her about into over "
    "under more most than then so if when while what which who whom whose how why all any each "
    "few other some such only own same too very s t just don now".split()
)
_WORD = re.compile(r"[a-zà-ÿ0-9']+")
_PASSAGE_MAX_CHARS = 400
MIN_MATCHED = 2
MIN_SCORE = 0.5


def _stem(word: str) -> str:
    return re.sub(r"(ing|ed|es|s)$", "", word)


def tokens(text: str) -> list[str]:
    return [_stem(w) for w in _WORD.findall(text.lower()) if len(w) > 1 and w not in STOP]


def paragraphs(transcript: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n+", transcript) if p.strip()]


def is_verbatim(phrase: str, transcript: str) -> bool:
    key = norm(phrase)
    return bool(key) and key in norm(transcript)


def closest_passage(phrase: str, transcript: str) -> dict[str, Any] | None:
    """The paragraph sharing the rarest words with the phrase, or None when
    nothing clears the upstream thresholds (two shared words, score 0.5)."""
    words = set(tokens(phrase))
    if not words:
        return None
    paras = paragraphs(transcript)
    if not paras:
        return None
    sets = [set(tokens(p)) for p in paras]
    df = {w: (sum(1 for s in sets if w in s) or 1) for w in words}
    best: tuple[float, int, int] | None = None
    for i, s in enumerate(sets):
        score = 0.0
        matched = 0
        for w in words:
            if w in s:
                score += 1 / df[w]
                matched += 1
        if matched < MIN_MATCHED or score < MIN_SCORE:
            continue
        if best is None or score > best[0]:
            best = (score, matched, i)
    if best is None:
        return None
    text = paras[best[2]]
    if len(text) > _PASSAGE_MAX_CHARS:
        text = text[: _PASSAGE_MAX_CHARS - 1].rstrip() + "…"
    return {"text": text, "score": round(best[0], 3), "matched": best[1]}


def ground_items(items: list[dict[str, Any]], transcript: str) -> list[dict[str, Any]]:
    """Annotate extractor output in place: `verbatim` and `source` per item."""
    for item in items:
        phrase = str(item.get("phrase") or "")
        item["verbatim"] = is_verbatim(phrase, transcript)
        item["source"] = closest_passage(phrase, transcript)
    return items
