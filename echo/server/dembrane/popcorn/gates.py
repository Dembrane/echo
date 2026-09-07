"""Deterministic gates on the two analysis slides, sent back to the model once.

Ported from Dembrane/popcorn `tools/name_check.py`, `tools/graph_check.py` and
`tools/screen_check.py` (commit 8c23eba).

- A stakeholder's name names one group of people. Joined with "and", "&", "/"
  or a comma it is two groups on one card; ending in a thing (the tool, the
  recording, AI) it is a thing on a card, and the people who make or run it
  are the group.
- The map is one map: every group is connected to every other through
  relations. An island is a second map drawn on the first.
- A tension is projected: poles three to seven words, the knot one sentence of
  at most eighteen, the question at most twenty-two, and none of them reports
  the meeting instead of the world.
"""

from __future__ import annotations

import re
from typing import Any
from collections import deque, defaultdict

# A comma joins two groups when a second name follows it ("Staff, Volunteers");
# a qualifier after it ("Residents, aged 65+") is one group.
JOINED = re.compile(r"(\band\b|&|/|,\s*(?-i:[A-ZÀ-Þ]))", re.IGNORECASE)
# A name that says who the people are is people, whatever word it ends in
# ("Women in Technology", "Users of the recording").
PEOPLE = re.compile(
    r"\b(people|persons?|staff|workers?|users?|members?|residents?|volunteers?|developers?|hosts?"
    r"|facilitators?|leaders?|managers?|teams?|citizens?|participants?|women|men|youth|parents?"
    r"|students?|employees?|customers?|clients?|partners?|funders?|commissioners?|officials?|experts?"
    r"|practitioners?|newcomers?|colleagues?|organisations?|organizations?|charities|charity|groups?"
    r"|communit(y|ies)|neighbou?rs?|families|family|founders?|owners?|directors?|board|councils?|makers?)\b",
    re.IGNORECASE,
)
# ...and a name whose last word is an abstraction (a pressure, a process, a
# culture) is a force on people wearing a card; the people it acts through are
# the group.
THING = re.compile(
    r"\b(tool|tools|system|systems|technology|software|platform|app|recording|recordings|algorithm"
    r"|ai|bot|machine|summary|dashboard|black box"
    r"|pressure|pressures|demand|demands|force|forces|factor|factors|trend|trends|process|processes"
    r"|structure|structures|culture|cultures|market|markets|environment|environments)$",
    re.IGNORECASE,
)

POLE_WORDS, KNOT_WORDS, QUESTION_WORDS = 7, 18, 22
POLE_MIN_WORDS = 3
SENTENCE_END = re.compile(r"[.!?](\s|$)")
MEETING = re.compile(
    r"\b(participants?|attendees|the (group|room|team) (discussed|recognised|recognized|acknowledged"
    r"|expressed|felt|noted)|discussed|recognis\w+|recogniz\w+|acknowledg\w+"
    r"|express\w+ (concern|a desire|the need)|feel(s|ing)? that|felt that)\b",
    re.IGNORECASE,
)


def _words(s: Any) -> int:
    return len(str(s or "").split())


def name_flags(stake: dict[str, Any]) -> list[str]:
    """One group, one name, and the group is people."""
    flags = []
    for g in stake.get("stakeholders") or []:
        name = str(g.get("name") or "")
        gid = g.get("id", "?")
        if JOINED.search(name):
            flags.append(f"{gid}: {name!r} joins two groups on one card; one group, one name")
        elif THING.search(name.strip()) and not PEOPLE.search(name):
            flags.append(
                f"{gid}: {name!r} names a thing, not people; name the people who make or run it"
            )
    return flags


def components(stake: dict[str, Any]) -> list[list[str]]:
    groups = [g["id"] for g in stake.get("stakeholders") or []]
    adj: dict[str, set[str]] = defaultdict(set)
    for r in stake.get("relations") or []:
        a, b = (r.get("between") or [None, None])[:2]
        if a in groups and b in groups and a != b:
            adj[a].add(b)
            adj[b].add(a)
    seen: set[str] = set()
    out: list[list[str]] = []
    for g in groups:
        if g in seen:
            continue
        comp, queue = [], deque([g])
        seen.add(g)
        while queue:
            x = queue.popleft()
            comp.append(x)
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    queue.append(y)
        out.append(comp)
    return out


def island_flags(stake: dict[str, Any]) -> list[str]:
    """One connected map, no group without a relation."""
    names = {g["id"]: g.get("name", g["id"]) for g in stake.get("stakeholders") or []}
    comps = components(stake)
    if len(comps) <= 1:
        return []
    comps.sort(key=len, reverse=True)
    flags = []
    for comp in comps[1:]:
        if len(comp) == 1:
            g = comp[0]
            flags.append(
                f"{g}: {names[g]!r} has no relation to any other group; add the relation the "
                f"transcripts support, or drop the group"
            )
        else:
            flags.append(
                "island: "
                + ", ".join(f"{g} {names[g]!r}" for g in comp)
                + " connect only to each other; add the relation that joins them to the rest, or drop them"
            )
    return flags


def screen_flags(tensions: dict[str, Any]) -> list[str]:
    """Every line of a tension lands in one glance from the back of the room."""
    flags = []
    for t in tensions.get("tensions") or []:
        tid = t.get("id", "?")
        for pole in ("poleA", "poleB"):
            n = _words(t.get(pole))
            if n > POLE_WORDS:
                flags.append(f"{tid} {pole}: {n} words, at most {POLE_WORDS}: {t.get(pole)!r}")
            elif n < POLE_MIN_WORDS:
                flags.append(f"{tid} {pole}: {n} words, at least {POLE_MIN_WORDS}: {t.get(pole)!r}")
        knot = str(t.get("knot") or "")
        if not knot:
            flags.append(f"{tid} knot: missing")
        elif _words(knot) > KNOT_WORDS:
            flags.append(f"{tid} knot: {_words(knot)} words, at most {KNOT_WORDS}: {knot!r}")
        elif len(SENTENCE_END.findall(knot.strip())) > 1:
            flags.append(f"{tid} knot: more than one sentence: {knot!r}")
        if not str(t.get("toResolve") or "").strip():
            flags.append(f"{tid} toResolve: missing")
        elif _words(t.get("toResolve")) > QUESTION_WORDS:
            flags.append(
                f"{tid} toResolve: {_words(t.get('toResolve'))} words, at most {QUESTION_WORDS}: "
                f"{t.get('toResolve')!r}"
            )
        for field in ("knot", "toResolve"):
            m = MEETING.search(str(t.get(field) or ""))
            if m:
                flags.append(
                    f"{tid} {field}: reports the meeting ({m.group(0)!r}): {t.get(field)!r}"
                )
    return flags
