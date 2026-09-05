"""Deterministic checks on a fast-pass response, before it reaches the room.

Ported from Dembrane/popcorn `tools/popcorn_flags.py` and `tools/known_text.py`
(commit 8c23eba). Three failure modes the extractor prompt cannot prevent on
its own, each caught by code:

- two phrases naming one idea (content-word overlap of a half or more);
- a phrase carrying a name somebody introduced themselves with, or was
  addressed by, in the transcript;
- a phrase quoting text the room was shown. In a live session the screen
  shows the previous tick's output and people read it aloud, so the
  transcript carries the tool's own words in the room's voice, and the
  model lifts them as the room's. Six consecutive words shared with anything
  the room has already been shown is the tool quoting itself.

The first two are decided per response; the third needs the previous state,
which the tick snapshots before it writes anything.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

WORD = re.compile(r"[a-z0-9']+")
STOP = set(
    "a an the and or of to in on at for is are was were be it its this that with as by from "
    "not no we you they he she i our your their his her them us me if so but than then".split()
)
KNOWN_RUN = 6
NEAR_DUPLICATE = 0.5

INTRO = re.compile(
    r"\b(?:I'm|I am|my name's|my name is|this is|Hi|Hey|Hello|Thanks|Thank you|Welcome),?\s+([A-Z][a-z]{2,})"
)
ADDRESSED = re.compile(
    r"\b([A-Z][a-z]{2,}),\s+(?:you're|you are|would you|are you|do you|what do you|be interesting|yeah|thanks|there's|sorry)"
    r"|\bwhat ([A-Z][a-z]{2,}) (?:was|is) saying|\bThanks,?\s+([A-Z][a-z]{2,})|\bto ([A-Z][a-z]{2,})'s point"
)
# Capitalised words the patterns above catch that are not names.
NOT_NAMES = set(
    "Okay Yeah Yes Well Good Right Fine Great Nice Lovely Cool Brilliant Fantastic Sorry Because "
    "Just There Here What When Where Which Dembrane".split()
)


def tokens(text: str) -> list[str]:
    return WORD.findall((text or "").casefold())


def content_tokens(text: str) -> set[str]:
    return {t for t in tokens(text) if t not in STOP and len(t) > 2}


def shingles(words: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def introduced_names(transcript: str) -> set[str]:
    """Names people gave in introductions or were addressed by."""
    found = set(INTRO.findall(transcript))
    for groups in ADDRESSED.findall(transcript):
        for name in groups if isinstance(groups, tuple) else (groups,):
            if name:
                found.add(name)
    return {n for n in found if n not in NOT_NAMES}


def name_hits(text: str, names: set[str]) -> list[str]:
    words = set(re.findall(r"[A-Za-z']+", text or ""))
    return sorted(words & names)


def scrub_names(text: str, names: set[str]) -> str:
    """Anything that may reach a screen loses the names from the introductions."""
    for n in sorted(names, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(n)}(?:'s)?\b", "a participant", text)
    return text


def jaccard(a: str, b: str) -> float:
    ta, tb = content_tokens(a), content_tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def known_run(text: str, known: set[tuple[str, ...]], n: int = KNOWN_RUN) -> str | None:
    """The first run of `n` words the text shares with the known text, or None."""
    if not known:
        return None
    for s in shingles(tokens(text), n):
        if s in known:
            return " ".join(s)
    return None


def _strings(value: Any, skip: Iterable[str] = ()) -> Iterable[str]:
    skip = set(skip)
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v, skip)
    elif isinstance(value, dict):
        for k, v in value.items():
            if k not in skip:
                yield from _strings(v, skip)


# Keys whose values the room never sees, or that are not prose.
_NOT_SHOWN = {"id", "url", "transcript", "source", "review", "fingerprint", "error", "label", "short"}


def known_shingles(state: dict[str, Any], n: int = KNOWN_RUN) -> set[tuple[str, ...]]:
    """Every run of `n` words in what the room has been shown so far: the
    phrases on the stage, the slides, the quotes behind them."""
    words: list[str] = []
    for conv in (state.get("conversations") or {}).values():
        for item in conv.get("items") or []:
            words += tokens(str(item.get("phrase") or ""))
            words.append("\x00")  # runs never cross from one text to the next
    for text in _strings(state.get("analysis") or {}, _NOT_SHOWN):
        words += tokens(text)
        words.append("\x00")
    for quote in state.get("quotes") or []:
        words += tokens(str(quote.get("text") or ""))
        words.append("\x00")
    return {s for s in shingles(words, n) if "\x00" not in s}


def gate_items(
    items: list[dict[str, Any]],
    *,
    names: set[str],
    known: set[tuple[str, ...]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split a shaped response into what the room may see and what it may not.

    Returns (kept, suppressed); each suppressed record carries the item and a
    one-line `reason` for the host's review, never for the room.
    """
    kept: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    for item in items:
        phrase = str(item.get("phrase") or "")
        hit = name_hits(phrase, names)
        if hit:
            suppressed.append({**item, "reason": f"carries a name from the introductions ({', '.join(hit)})"})
            continue
        run = known_run(phrase, known)
        if run:
            suppressed.append({**item, "reason": f"shares {KNOWN_RUN} words with text the room was shown ({run!r})"})
            continue
        twin = next((k for k in kept if jaccard(k["phrase"], phrase) >= NEAR_DUPLICATE), None)
        if twin is not None:
            if int(item.get("weight") or 1) > int(twin.get("weight") or 1):
                # The heavier of two phrases for one idea is the one that stays.
                suppressed.append({**twin, "reason": f"says what {phrase!r} says, with less weight"})
                kept[kept.index(twin)] = item
            else:
                suppressed.append({**item, "reason": f"says what {twin['phrase']!r} says"})
            continue
        kept.append(item)
    return kept, suppressed
