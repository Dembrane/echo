"""Runs the Python tensions pipeline on fixed arguments with a scripted model, recording
every call and the result, so the TypeScript port can replay the answers and must send
the same prompts and produce the same result."""
import sys; sys.path.insert(0, ".")
import asyncio, hashlib, json, re, sys
from dembrane.analysis.recipes import tensions as T

C1, C2, C3 = "c1000000-0000-4000-8000-000000000001", "c1000000-0000-4000-8000-000000000002", "c1000000-0000-4000-8000-000000000003"
TEXTS = {
    C1: "We need more charging points near the flats, the waiting list is months long.\nBuses stop running at eleven, so people drive even when they would rather not.\nThe council plan says every street gets a lane by next year.",
    C2: "Typed answer: the cycle lanes end abruptly at the ring road.\nI would rather cycle than drive if it felt safe.",
    C3: "We should keep the parking free for residents, people need their cars.\nMaybe we could put the bus money into the roads instead.",
}
LOC = {"offset": 12, "basis": "collapsed-casefold-v1"}
ARGS = [
    ("r1", "o1", "claim", "Charging points near the flats are far too few.", [(C1, "the waiting list is months long", LOC)]),
    ("r2", "o2", "argument", "Buses should run later at night so people can leave the car.", [(C1, "Buses stop running at eleven", None)]),
    ("r3", "o3", "argument", "Cycle lanes should continue past the ring road.", [(C2, "the cycle lanes end abruptly at the ring road", LOC)]),
    ("r4", "o4", "argument", "Resident parking must stay free.", [(C3, "keep the parking free for residents", None), (C2, "I would rather cycle than drive", None)]),
    ("r5", "o5", "argument", "Maybe the bus money should go to roads instead.", [(C3, "put the bus money into... the roads instead", None)]),
    ("r6", "o6", "argument", "An argument with no evidence at all.", []),
    ("r7", "o7", "claim", "An argument whose quote is nowhere.", [(C2, "words nobody ever said here", None)]),
]
arguments = [
    T.ArgumentRevision(revision_id=r, object_id=o, type="argument", statement=s, epistemic_kind=k,
                       evidence=tuple(T.Evidence(c, q, l) for c, q, l in ev))
    for r, o, k, s, ev in ARGS
]
sources = [T.SourcePassages(cid, f"Conversation {i}", transcript=TEXTS[cid]) for i, cid in enumerate((C1, C2, C3), start=1)]

calls = []
dedupe_calls = 0
write_seen = set()

def answer(system, user, schema):
    global dedupe_calls
    if schema is T.stages.HANDED_SCHEMA:
        return {"handed": [
            {"text": "A council plan for lanes", "quote": "the council plan says", "transcript": C2, "response": "argued about it", "status": "argued"},
            {"text": "A rumour", "quote": "nobody heard this", "transcript": C3, "response": "ignored", "status": "ignored"},
        ]}
    if schema is T.COLLISIONS_SCHEMA:
        focal = re.search(r"FOCAL POSITIONS: (.*)$", user, re.M).group(1).split(", ")
        ids = re.findall(r"^(P\d+) \[", user, re.M)
        out = []
        for pid in focal:
            i = ids.index(pid)
            other = ids[(i + 1) % len(ids)]
            out.append({"focal": pid, "other": other, "question": f"Who gets {pid}?", "why": f"{pid} pulls against {other}", "zero_sum": 0.5 + 0.1 * i})
        out.append({"focal": focal[0], "other": "P99", "question": "x", "why": "x", "zero_sum": 0.9})
        out.append({"focal": focal[0], "other": ids[-1], "question": "low", "why": "low", "zero_sum": 0.1})
        return {"collisions": out}
    if schema is T.VERIFY_SCHEMA:
        valid = ("parking" in user and ("Cycle" in user or "Charging" in user)) or ("Buses" in user and "bus money" in user)
        return {"valid": valid, "opposed": valid, "question": "How should street space be shared?" if valid else "",
                "reason": "they answer one question oppositely" if valid else "they do not answer one question",
                "poleA": "Keep the street as it is" if valid else "", "poleB": "Change the street for other modes" if valid else ""}
    if schema is T.stages.DEDUPE_SCHEMA:
        dedupe_calls += 1
        if "Buses" in user or dedupe_calls == 1:
            return {"same_as": "x1", "swapped": True, "why": "the same pull from another room"}
        return {"same_as": "", "swapped": False, "why": "a new pull"}
    if schema is T.SUPPORT_SCHEMA:
        lines = re.findall(r"^(P\d+) \[\w+\] (.*)$", user, re.M)
        out = []
        for i, (pid, text) in enumerate(lines):
            pole = "A" if ("Charging" in text or "parking" in text) else "B"
            out.append({"id": pid, "pole": pole, "strength": [0.9, 0.8, 0.7, 0.6][i % 4], "why": f"{pid} holds {pole}"})
        out.append({"id": "P77", "pole": "A", "strength": 1, "why": "not proposed"})
        return {"supporters": out}
    if schema is T.WRITE_SCHEMA:
        if "## Your previous answer failed these checks" not in system:
            return {"poleA": "Keep the street", "poleB": "Change the street for bikes and buses",
                    "knot": "Cars keep their space but cycling stays unsafe and and slow", "toResolve": "How should the street be shared"}
        return {"poleA": "Keep the street as it is", "poleB": "Change the street for cycling",
                "knot": "Free parking eases daily life, but it takes the space safe cycle lanes need.",
                "toResolve": "How much street space should parking keep?"}
    raise AssertionError("unknown schema")

async def generate(*, system_prompt, user_text, schema, thinking=True):
    a = answer(system_prompt, user_text, schema)
    calls.append({"system": hashlib.sha256(system_prompt.encode()).hexdigest(), "user": user_text, "thinking": thinking, "answer": a})
    return a

res = asyncio.run(T.run_tensions(arguments, sources, generate=generate))
d = res.as_dict()
d["usage"]["wall_ms"] = 0
thin = asyncio.run(T.run_tensions(arguments[:2], sources, generate=generate)).as_dict()
thin["usage"]["wall_ms"] = 0
calls.sort(key=lambda c: (c["system"], c["user"]))
json.dump({"texts": TEXTS, "arguments": [dict(zip(["revisionId","objectId","kind","statement","evidence"], a)) for a in ARGS],
           "calls": calls, "result": d, "thin": thin}, sys.stdout, indent=1, ensure_ascii=False, default=list)
