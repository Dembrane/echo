"""Tensions as a pipeline of single judgements.

Ported from Dembrane/popcorn `tools/tensions_pipeline.py` (commit 8c23eba),
the threads replaced by the tick's event loop. Five stages, every call one
judgement:

1. positions   one call per transcript: every want, constraint and value held,
               with its holder (never a name) and a verbatim quote
2. collisions  one call per position: which other positions, across all
               tables, it collides with, and how zero-sum each collision is
3. verify      one call per candidate pair, with the two transcripts the pair
               came from and the list of what the rooms were handed in view
4. dedupe      one call per verified pair, in rank order, against the tensions
               already kept: the same tension, a facet of one, or a new one
5. write       one call per kept tension: the knot and the question, then the
               screen gate, with one retry

Cross-table pairs rank first, then by how zero-sum they are. The output is the
deck's `tensions.json` shape; the quotes go into the tick's shared registry.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Awaitable

from dembrane.popcorn.gates import screen_flags
from dembrane.popcorn.analysis import QuoteBook, norm

PROMPT_NAMES = ("positions", "collisions", "tension-verify", "tension-write", "tensions-handed")
MAX_TENSIONS = 8
MAX_POSITIONS_PER_TRANSCRIPT = 30
MIN_ZERO_SUM = 0.2
MAX_QUOTES_PER_TENSION = 4

POSITIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["positions"],
    "properties": {
        "positions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["position", "holder", "kind", "hedged", "quote"],
                "properties": {
                    "position": {"type": "string", "maxLength": 200},
                    "holder": {"type": "string", "maxLength": 80},
                    "kind": {"type": "string", "enum": ["want", "constraint", "value"]},
                    "hedged": {"type": "boolean"},
                    "quote": {"type": "string", "maxLength": 400},
                },
            },
        }
    },
}
COLLISIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["collides"],
    "properties": {
        "collides": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "why", "zero_sum"],
                "properties": {
                    "id": {"type": "string", "maxLength": 12},
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
    "required": ["valid", "why", "poleA", "poleB", "quotesA", "quotesB"],
    "properties": {
        "valid": {"type": "boolean"},
        "why": {"type": "string", "maxLength": 300},
        "poleA": {"type": "string", "maxLength": 60},
        "poleB": {"type": "string", "maxLength": 60},
        "quotesA": {"type": "array", "items": {"type": "string", "maxLength": 400}},
        "quotesB": {"type": "array", "items": {"type": "string", "maxLength": 400}},
    },
}
DEDUPE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["same_as", "why"],
    "properties": {
        "same_as": {"type": "string", "maxLength": 12},
        "why": {"type": "string", "maxLength": 240},
    },
}
WRITE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["poleA", "poleB", "knot", "toResolve"],
    "properties": {
        "poleA": {"type": "string", "maxLength": 60},
        "poleB": {"type": "string", "maxLength": 60},
        "knot": {"type": "string", "maxLength": 140},
        "toResolve": {"type": "string", "maxLength": 170},
    },
}
HANDED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["handed"],
    "properties": {
        "handed": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "quote", "transcript", "response", "status"],
                "properties": {
                    "text": {"type": "string", "maxLength": 600},
                    "quote": {"type": "string", "maxLength": 400},
                    "transcript": {"type": "string"},
                    "response": {"type": "string", "maxLength": 300},
                    "status": {
                        "type": "string",
                        "enum": [
                            "accepted",
                            "argued",
                            "called_false",
                            "reversed",
                            "dissolved",
                            "ignored",
                        ],
                    },
                },
            },
        }
    },
}

DEDUPE_SYSTEM = """You are given the tensions already kept from a session and one more verified
tension. Say whether the new one belongs to one already kept. It belongs when
it is the same pull between the same two things, however worded and whoever
held it; and also when it is a facet of a kept tension: it shares one pole
with it and its other pole is a middle course between the kept poles, a
reason behind one of them, or a consequence of one of them (the kept tension's
knot will carry the facet). Return `same_as` with the id of the kept tension
it belongs to, or an empty string when it pulls between two things no kept
tension pulls between, and a `why` of one line. Two tensions on the same
subject that pull between different things are not the same; two tensions
that share a pole and pull on the same thing from two angles are."""

Generate = Callable[..., Awaitable[dict[str, Any]]]


def _corpus(transcripts: dict[str, str], tids: list[str]) -> str:
    return "\n\n".join(f"TRANSCRIPT id: {t}\n{transcripts[t]}\nEND TRANSCRIPT {t}" for t in tids)


async def run_pipeline(
    transcripts: dict[str, str],
    book: QuoteBook,
    *,
    generate: Generate,
    prompts: dict[str, str],
    concurrency: int = 8,
    max_tensions: int = MAX_TENSIONS,
) -> dict[str, Any]:
    """`generate(system_prompt=, user_text=, schema=, thinking=)` is one model
    call returning the structured answer. Returns the tensions block, the
    screen flags left after the retry, and the stage counts for the run log."""
    tids = list(transcripts)
    sem = asyncio.Semaphore(concurrency)

    async def gen(
        system: str, user: str, schema: dict[str, Any], thinking: bool = True
    ) -> dict[str, Any]:
        async with sem:
            return await generate(
                system_prompt=system, user_text=user, schema=schema, thinking=thinking
            )

    # 0. what the rooms were handed, over the whole corpus
    handed = (await gen(prompts["tensions-handed"], _corpus(transcripts, tids), HANDED_SCHEMA)).get(
        "handed"
    ) or []
    handed_text = (
        "\n".join(
            f"- [{h.get('status')}] {h.get('text')}\n  what the rooms did: {h.get('response')}"
            for h in handed
        )
        or "- nothing was handed to the rooms"
    )

    # 1. positions per transcript
    async def positions_for(tid: str) -> list[dict[str, Any]]:
        out = await gen(
            prompts["positions"],
            f"TRANSCRIPT id: {tid}\n{transcripts[tid]}\nEND TRANSCRIPT",
            POSITIONS_SCHEMA,
        )
        found = []
        for p in (out.get("positions") or [])[:MAX_POSITIONS_PER_TRANSCRIPT]:
            if not isinstance(p, dict) or not p.get("position"):
                continue
            found.append(
                {
                    **p,
                    "transcript": tid,
                    "verbatim": norm(str(p.get("quote") or "")) in norm(transcripts[tid]),
                }
            )
        return found

    positions: list[dict[str, Any]] = []
    for found in await asyncio.gather(*(positions_for(t) for t in tids)):
        for p in found:
            positions.append({"id": f"P{len(positions) + 1}", **p})
    by_id = {p["id"]: p for p in positions}

    # 2. collisions per position, across all tables
    key = {t: f"T{i + 1}" for i, t in enumerate(tids)}
    listing = "\n".join(
        f"{p['id']} [{key[p['transcript']]} · {p.get('holder')} · {p.get('kind')}{' · hedged' if p.get('hedged') else ''}] {p['position']}"
        for p in positions
    )

    async def collisions_for(p: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
        out = await gen(
            prompts["collisions"],
            f"ALL POSITIONS:\n{listing}\n\nFOCAL POSITION: {p['id']}",
            COLLISIONS_SCHEMA,
        )
        return p["id"], [c for c in (out.get("collides") or []) if isinstance(c, dict)]

    pair: dict[tuple[str, str], dict[str, Any]] = {}
    for pid, cols in await asyncio.gather(*(collisions_for(p) for p in positions)):
        for c in cols:
            other = str(c.get("id") or "").strip()
            try:
                score = float(c.get("zero_sum") or 0)
            except (TypeError, ValueError):
                continue
            if other not in by_id or other == pid or score < MIN_ZERO_SUM:
                continue
            k = (min(pid, other), max(pid, other))
            prev = pair.get(k)
            if not prev or score > prev["zero_sum"]:
                pair[k] = {
                    "a": k[0],
                    "b": k[1],
                    "zero_sum": score,
                    "why": str(c.get("why") or ""),
                    "cross_table": by_id[k[0]]["transcript"] != by_id[k[1]]["transcript"],
                    "named_by": (prev["named_by"] if prev else []) + [pid],
                }
            else:
                prev["named_by"].append(pid)
    candidates = sorted(
        pair.values(), key=lambda c: (not c["cross_table"], -c["zero_sum"], -len(c["named_by"]))
    )

    # 3. verify each candidate against its transcripts
    async def verify(c: dict[str, Any]) -> dict[str, Any]:
        a, b = by_id[c["a"]], by_id[c["b"]]
        ts = sorted({a["transcript"], b["transcript"]})
        user = (
            f"{_corpus(transcripts, ts)}\n\nWHAT THE ROOMS WERE HANDED:\n{handed_text}\n\n"
            f'THE PAIR:\nA ({a.get("holder")}, {a.get("kind")}): {a["position"]}\n   said: "{a.get("quote")}"\n'
            f'B ({b.get("holder")}, {b.get("kind")}): {b["position"]}\n   said: "{b.get("quote")}"\n'
            f"Flagged because: {c['why']}"
        )
        out = await gen(prompts["tension-verify"], user, VERIFY_SCHEMA)
        in_ts = lambda q: any(norm(q) in norm(transcripts[t]) for t in ts)  # noqa: E731
        qa = [q for q in (out.get("quotesA") or []) if isinstance(q, str) and in_ts(q)][:2]
        qb = [q for q in (out.get("quotesB") or []) if isinstance(q, str) and in_ts(q)][:2]
        return {
            **c,
            "valid": bool(out.get("valid")),
            "verify_why": str(out.get("why") or ""),
            "poleA": str(out.get("poleA") or "").strip(),
            "poleB": str(out.get("poleB") or "").strip(),
            "quotesA": qa,
            "quotesB": qb,
            "transcripts": ts,
        }

    verified = list(await asyncio.gather(*(verify(c) for c in candidates)))
    valid = [v for v in verified if v["valid"] and v["poleA"] and v["poleB"]]

    # 4. dedupe in rank order, one call per pair against what is kept
    kept: list[dict[str, Any]] = []
    for v in valid:
        if not kept:
            kept.append({**v, "id": f"x{len(kept) + 1}"})
            continue
        listing_kept = "\n".join(f"{k['id']}: {k['poleA']} / {k['poleB']}" for k in kept)
        out = await gen(
            DEDUPE_SYSTEM,
            f"KEPT:\n{listing_kept}\n\nNEW: {v['poleA']} / {v['poleB']}\n  (from: {v['why']})",
            DEDUPE_SCHEMA,
            thinking=False,
        )
        same = str(out.get("same_as") or "").strip()
        target = next((k for k in kept if k["id"] == same), None) if same else None
        if target is not None:
            target.setdefault("merged", []).append(
                {"a": v["a"], "b": v["b"], "why": str(out.get("why") or "")}
            )
            for q in v["quotesA"] + v["quotesB"]:
                if q not in target["quotesA"] + target["quotesB"] and (
                    len(target["quotesA"]) + len(target["quotesB"]) < MAX_QUOTES_PER_TENSION
                ):
                    (
                        target["quotesA"]
                        if len(target["quotesA"]) <= len(target["quotesB"])
                        else target["quotesB"]
                    ).append(q)
            continue
        kept.append({**v, "id": f"x{len(kept) + 1}"})
        if len(kept) >= max_tensions:
            break

    # 5. write each, then the screen gate with one retry
    async def write(k: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        facets = [
            f"- {by_id[m['a']]['position']}  /  {by_id[m['b']]['position']}"
            for m in k.get("merged", [])
            if m.get("a") in by_id and m.get("b") in by_id
        ]
        user = (
            f"POLE A: {k['poleA']}\nPOLE B: {k['poleB']}\n"
            "HOLDING A: " + " | ".join(f'"{q}"' for q in k["quotesA"]) + "\n"
            "HOLDING B: " + " | ".join(f'"{q}"' for q in k["quotesB"]) + "\n"
            f"WHAT COLLIDES: {k['why']}"
            + (
                (
                    "\nFACETS OF THE SAME PULL, FOUND IN OTHER ROOMS (a middle course among them belongs in the "
                    "knot, not as a resolution but as what the room reached for):\n"
                    + "\n".join(facets)
                )
                if facets
                else ""
            )
        )

        def shaped(out: dict[str, Any]) -> dict[str, Any]:
            pole = lambda f: str(out.get(f) or "").strip() or k[f]  # noqa: E731
            return {
                "id": k["id"],
                "poleA": pole("poleA"),
                "poleB": pole("poleB"),
                "knot": str(out.get("knot") or "").strip(),
                "toResolve": str(out.get("toResolve") or "").strip(),
            }

        t = shaped(await gen(prompts["tension-write"], user, WRITE_SCHEMA))
        flags = screen_flags({"tensions": [t]})
        if flags:
            retry_prompt = (
                prompts["tension-write"]
                + "\n\n## Your previous answer failed these checks\n\n"
                + "\n".join(f"- {f}" for f in flags)
                + "\n\nFix every one of them."
            )
            t = shaped(await gen(retry_prompt, user, WRITE_SCHEMA))
            flags = screen_flags({"tensions": [t]})
        return t, flags

    tensions: list[dict[str, Any]] = []
    gate_flags: list[str] = []
    written = await asyncio.gather(*(write(item) for item in kept))
    for (tension, flags), item in zip(written, kept, strict=True):
        tension["quoteIds"] = book.add_all(
            [{"transcript": item["transcripts"][0], "text": q} for q in item["quotesA"]]
            + [{"transcript": item["transcripts"][-1], "text": q} for q in item["quotesB"]]
        )
        tensions.append(tension)
        gate_flags += flags
    return {
        "tensions": {"tensions": tensions},
        "gate_flags": gate_flags,
        "counts": {
            "handed": len(handed),
            "positions": len(positions),
            "candidates": len(candidates),
            "cross_table": sum(1 for c in candidates if c["cross_table"]),
            "verified": len(valid),
            "kept": len(kept),
        },
    }
