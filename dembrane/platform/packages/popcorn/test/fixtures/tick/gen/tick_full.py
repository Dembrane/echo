"""Drive the Python popcorn tick end to end with an in-memory Directus and scripted model
answers; record every model call and the rows the tick leaves, for the TS integration test."""
import asyncio, json, sys, copy, re, uuid
from datetime import datetime, timezone

import dembrane.popcorn.ticks as T
import dembrane.popcorn.model as M
import dembrane.popcorn.bundle as B
import dembrane.popcorn.service as S
from dembrane.directus_async import async_directus
from dembrane.popcorn.tensions import DEDUPE_SYSTEM

def now_iso():
    return datetime.now(timezone.utc).isoformat()

DB = {}
def rows(c):
    return DB.setdefault(c, {})

def match(row, flt):
    for field, cond in flt.items():
        v = row.get(field)
        for op, arg in cond.items():
            if op == "_eq" and (v is None or str(v) != str(arg)): return False
            if op == "_null" and (v is None) != bool(arg): return False
            if op == "_nnull" and (v is None) == bool(arg): return False
            if op == "_in" and str(v) not in [str(a) for a in arg]: return False
            if op == "_gt" and not (v is not None and str(v) > str(arg)): return False
            if op == "_lte" and not (v is not None and str(v) <= str(arg)): return False
            if op == "_lt" and not (v is not None and str(v) < str(arg)): return False
    return True

async def get_items(collection, params=None, **kw):
    q = (params or {}).get("query") or {}
    out = [copy.deepcopy(r) for r in rows(collection).values() if match(r, q.get("filter") or {})]
    for key in reversed(q.get("sort") or []):
        desc = key.startswith("-")
        k = key.lstrip("-")
        out.sort(key=lambda r: (r.get(k) is None, str(r.get(k))), reverse=desc)
    lim = q.get("limit")
    if lim and lim > 0: out = out[:lim]
    return out

async def get_item(collection, item_id, **kw):
    r = rows(collection).get(str(item_id))
    return copy.deepcopy(r) if r else None

SPECIAL_CREATE = {"agent_loop": ["created_at"], "canvas_generation": ["created_at"], "canvas_config_revision": ["created_at"], "project_report": ["date_created"]}
async def create_item(collection, data, **kw):
    row = copy.deepcopy(data)
    row.setdefault("id", str(uuid.uuid4()))
    for f in SPECIAL_CREATE.get(collection, []): row.setdefault(f, now_iso())
    rows(collection)[str(row["id"])] = row
    return {"data": copy.deepcopy(row)}

async def update_item(collection, item_id, data, **kw):
    row = rows(collection)[str(item_id)]
    row.update(copy.deepcopy(data))
    if collection == "agent_loop": row["updated_at"] = now_iso()
    return {"data": copy.deepcopy(row)}

async_directus.get_items = get_items
async_directus.get_item = get_item
async_directus.create_item = create_item
async_directus.update_item = update_item

class FakeRedis:
    def __init__(self): self.kv = {}
    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv: return None
        self.kv[k] = v; return True
    async def get(self, k): return self.kv.get(k)
    async def delete(self, k): self.kv.pop(k, None)
    async def exists(self, k): return 1 if k in self.kv else 0
    async def expire(self, k, s): return True
    async def eval(self, *a): return 1
redis = FakeRedis()
async def get_redis(): return redis
T.get_redis_client = get_redis
S.get_redis_client = get_redis
async def nudge(rid): return None
T.publish_generation_nudge = nudge
async def reader(**kw): return None
T.resolve_canvas_reader_context = reader
async def no_objects(project_id, **kw): return B.DeckObjects()
B.load_deck_objects = no_objects
import dembrane.analysis.popcorn_import as PI
async def not_owned(*a, **kw): return False
PI.analysis_owns = not_owned
import dembrane.analysis.executor as EX
EX.default_store = lambda: None

PROMPTS = {name: M.prompt_text(name) for name in ["popcorn-v1.7", "popcorn-validate", "popcorn-kind", "popcorn-question", "stakeholders-v0.9", "popcorn-translate", "positions", "collisions", "tension-verify", "tension-write", "tensions-handed"]}
def which(system):
    if system == DEDUPE_SYSTEM: return "dedupe"
    for name, text in PROMPTS.items():
        if system == text or system.startswith(text + "\n\n## Your previous answer"): return name
    return "?"

CALLS = []
def between(text, a, b):
    return text.split(a, 1)[1].split(b, 1)[0]

def answer(name, system, user):
    if name == "popcorn-v1.7":
        window = between(user, "TRANSCRIPT START\n", "\nTRANSCRIPT END")
        items = []
        for line in window.split("\n"):
            words = re.findall(r"[A-Za-z']+", line)
            if len(words) >= 3: items.append({"phrase": " ".join(words[:5])})
        if "Buses" in window: items.append({"phrase": "Why do buses stop?"})
        items.append({"phrase": "nothing grounded here at all"})
        return {"items": items}
    if name == "popcorn-validate":
        transcript = between(user, "\n", "\nEND TRANSCRIPT")
        phrase = user.rsplit(":\n", 1)[1]
        if "nothing" in phrase: return {"grounded": False, "quote": "", "reason": "not said"}
        first = re.findall(r"[A-Za-z']+", phrase)[-1].lower()
        line = next((l for l in transcript.split("\n") if first in l.lower()), "")
        return {"grounded": bool(line), "quote": line.strip(), "reason": "said so"}
    if name == "popcorn-kind":
        phrase = user.rsplit(":\n", 1)[1]
        if phrase.lower().startswith("why"):
            return {"kind": "question", "qualifiers": [], "question_form": False, "target": "", "reason": "asks"}
        return {"kind": "need", "qualifiers": ["tentative", "junk"], "question_form": False, "target": "Maria's plan", "reason": "Maria wants it"}
    if name == "popcorn-question":
        phrase = user.rsplit(":\n", 1)[1]
        return {"phrase": phrase[:1].upper() + phrase[1:] + "?"}
    if name == "stakeholders-v0.9":
        corpus = between(user, "TRANSCRIPT START\n", "\nTRANSCRIPT END")
        lines = [l.strip() for l in corpus.split("\n") if len(l.strip()) > 20 and not l.startswith(("TRANSCRIPT", "END"))]
        first = "Staff" if "previous answer failed" in system else "Staff and Volunteers"
        return {"stakeholders": [
            {"name": "Residents", "role": "people who live here", "stake": "getting around", "rung": "voiced", "stakeWeight": 0.9, "mentionsWeight": 1, "quotes": [{"transcript": "wrong", "text": lines[0]}]},
            {"name": first, "role": "people who work here", "stake": "their shifts", "rung": "named", "invokedBy": "Residents", "stakeWeight": 0.45, "mentionsWeight": 0.333, "quotes": [{"transcript": "x", "text": lines[-1], "context": "Near the end"}]},
        ], "relations": [{"between": ["Residents", first], "label": "rely on", "intensity": 0.7, "sentiment": -0.25, "unowned": False, "detail": "Residents rely on the staff for help.", "aspects": [{"kind": "risk", "note": "They might leave soon.", "quotes": [{"transcript": "x", "text": lines[1]}]}]}]}
    if name == "tensions-handed":
        return {"handed": [{"text": "A plan from the council", "quote": "not in any transcript", "transcript": "x", "response": "argued", "status": "argued"}]}
    if name == "positions":
        body = between(user, "\n", "\nEND TRANSCRIPT")
        lines = [l.strip() for l in body.split("\n") if l.strip()]
        return {"positions": [{"position": f"holds {l[:30]}", "holder": "a resident", "kind": "want", "hedged": i == 1, "quote": l} for i, l in enumerate(lines[:2])]}
    if name == "collisions":
        focal = user.rsplit("FOCAL POSITION: ", 1)[1].strip()
        ids = re.findall(r"^(P\d+) \[", user, re.M)
        if focal == ids[0]: return {"collides": [{"id": ids[-1], "why": "they pull apart", "zero_sum": 0.8}, {"id": focal, "why": "self", "zero_sum": 1}]}
        return {"collides": [{"id": "P99", "why": "gone", "zero_sum": 0.9}]}
    if name == "tension-verify":
        a = re.search(r'A \(.*?\): .*\n   said: "(.*)"', user).group(1)
        b = re.search(r'B \(.*?\): .*\n   said: "(.*)"', user).group(1)
        return {"valid": True, "why": "real", "poleA": "More charging points now", "poleB": "Keep the late buses running", "quotesA": [a, "made up line"], "quotesB": [b]}
    if name == "dedupe":
        return {"same_as": "", "swapped": False, "why": "new"}
    if name == "tension-write":
        if "failed these checks" in system:
            return {"poleA": "More charging points now", "poleB": "Keep late buses running", "knot": "Money for one comes from the other.", "toResolve": "Which comes first this year?"}
        return {"poleA": "", "poleB": "Buses", "knot": "It is one. It is two.", "toResolve": "Which?"}
    if name == "popcorn-translate":
        payload = json.loads(user)
        return {"translations": [{"i": t["i"], "text": "NL " + t["text"]} for t in payload["texts"]]}
    raise RuntimeError("no scripted answer for " + name)

async def structured(*, system_prompt, user_text, schema, max_tokens, fast, timeout):
    name = which(system_prompt)
    out = answer(name, system_prompt, user_text)
    CALLS.append({"name": name, "system": system_prompt, "user": user_text, "max_tokens": max_tokens, "fast": fast, "answer": out})
    return copy.deepcopy(out)
M._structured_completion = structured

U = "d1000000-0000-4000-8000-000000000001"
P = "f1000000-0000-4000-8000-000000000001"
C = "ca100000-0000-4000-8000-000000000002"
L = "ca100000-0000-4000-8000-000000000001"
C1 = "c1100000-0000-4000-8000-000000000001"
C2 = "c1100000-0000-4000-8000-000000000002"
SEED = {
    "project": [{"id": P, "name": "City", "language": "en", "workspace_id": None, "directus_user_id": U, "is_conversation_allowed": True, "is_canvas_enabled": True, "anonymize_transcripts": False, "deleted_at": None}],
    "project_report": [{"id": "7", "project_id": P, "kind": "popcorn", "status": "published", "user_instructions": "City session", "content": "", "public_token": "tok", "date_created": "2026-09-01T09:00:00.000Z", "deleted_at": None}],
    "canvas_config_revision": [{"id": C, "report_id": 7, "created_at": "2026-09-01T09:00:00.000Z", "popcorn_settings": {"title": "City session", "public": True, "voice": {"presets": ["gentle"], "note": ""}, "language": {"ui": "auto", "translate_to": "nl", "also": ["de"]}, "public_labels": "names"}}],
    "agent_loop": [{"id": L, "project_id": P, "report_id": 7, "name": "City session", "status": "paused", "expires_at": "2026-09-01T09:00:00.000Z", "cadence_minutes": 2, "acting_directus_user_id": U, "failure_count": 0, "caps": {"kind": "popcorn"}, "popcorn_state": {"version": 2, "run": 0, "order": [], "conversations": {}, "quotes": [], "analysis": None}, "created_at": "2026-09-01T09:00:00.000Z"}],
    "conversation": [
        {"id": C1, "project_id": P, "participant_name": "Resident 1", "created_at": "2026-09-01T09:20:00.000Z", "duration": 312.5, "deleted_at": None},
        {"id": C2, "project_id": P, "participant_name": None, "created_at": "2026-09-01T09:40:00.000Z", "duration": 60, "deleted_at": None},
    ],
    "conversation_chunk": [
        {"id": "ch1", "conversation_id": C1, "transcript": "Hi, I'm Maria from the flats.\nWe need more charging points near the flats, the waiting list is months long.", "timestamp": "2026-09-01T09:20:00.000Z", "created_at": "2026-09-01T09:20:00.000Z"},
        {"id": "ch2", "conversation_id": C1, "transcript": "Buses stop running at eleven, so people drive even when they would rather not.", "timestamp": "2026-09-01T09:21:00.000Z", "created_at": "2026-09-01T09:21:00.000Z"},
        {"id": "ch3", "conversation_id": C2, "transcript": "Heat pumps are fine but the grid connection took our street a year.\nThe council never answers our letters about the grid.", "timestamp": "2026-09-01T09:40:00.000Z", "created_at": "2026-09-01T09:40:00.000Z"},
        {"id": "ch4", "conversation_id": C2, "transcript": None, "timestamp": "2026-09-01T09:41:00.000Z", "created_at": "2026-09-01T09:41:00.000Z"},
    ],
}
SECOND_CHUNK = {"id": "ch5", "conversation_id": C2, "transcript": "Night buses would help the nurses on late shifts get home safely.", "timestamp": "2026-09-01T09:42:00.000Z", "created_at": "2026-09-01T09:42:00.000Z"}
for c, rs in SEED.items():
    for r in rs: rows(c)[str(r["id"])] = copy.deepcopy(r)

async def main():
    ticks = []
    for step, (kind, rid) in enumerate([("manual", "11111111-1111-4111-8111-111111111111"), ("manual", "22222222-2222-4222-8222-222222222222"), ("rerun", None)]):
        if step == 1:
            rows("conversation_chunk")["ch5"] = copy.deepcopy(SECOND_CHUNK)
        start = len(CALLS)
        result = await T.run_popcorn_tick(L, kind, request_id=rid)
        loop = rows("agent_loop")[L]
        versions = sorted(rows("canvas_generation").values(), key=lambda r: r["created_at"])
        ticks.append({
            "kind": kind, "request_id": rid, "status": result["status"],
            "state": copy.deepcopy(loop["popcorn_state"]),
            "run": copy.deepcopy(result["run"]),
            "version": copy.deepcopy(versions[-1]) if versions else None,
            "calls": CALLS[start:],
            "tasks": copy.deepcopy(list(rows("scheduled_task").values())),
            "loop": {k: loop[k] for k in ("status", "failure_count", "name")},
        })
    json.dump({"seed": SEED, "second_chunk": SECOND_CHUNK, "ticks": ticks}, sys.stdout, ensure_ascii=False, indent=1, default=str)

asyncio.run(main())
