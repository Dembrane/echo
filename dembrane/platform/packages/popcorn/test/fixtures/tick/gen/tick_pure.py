"""Fixtures for the tick's pure parts: every case is an input and what the Python returns."""
import json, sys, copy
from dembrane.popcorn import ticks as T
from dembrane.popcorn import analysis as A, flags as F, gates as G, grounding as GR, enrichment as E

out = {}
def rec(name, inp, res):
    out.setdefault(name, []).append({"in": inp, "out": res})

texts = [
    "Hi, I'm Maria and I run the café.\nWe need more charging points near the flats, the waiting list is months long.\nBuses stop running at eleven, so people drive.",
    "Thanks Pieter, you're right.\nHello Jan! Welcome, Éva.\nMy name is Okay.\nWhat Anna was saying matters. To Bram's point, yes.",
    "short",
    "line one\n" + ("x" * 30 + "\n") * 3,
    "Ünïcödé text with ñ and 😀 emoji.\nSecond line here.",
]
for t in texts:
    rec("fingerprint", t, T._fingerprint(t))
    rec("introduced_names", t, sorted(F.introduced_names(t)))
for t, cap in [("a" * 50, 40), ("a" * 30 + "\n" + "b" * 30, 40), ("x" * 3000 + "\n" + "y" * 10, 100), ("short", 10), ("é" * 50, 40)]:
    rec("model_window", [t, cap], T.model_window(t, cap))
for name, i in [("Resident 1", 1), ("", 3), ("   ", 2), ("A very long participant name that goes on", 1), (None, 4), ("😀" * 30, 1)]:
    rec("labels_for", [name, i], list(T.labels_for({"participant_name": name}, i)))

raws = [
    {"items": [{"phrase": "  More   charging points.  "}, {"phrase": "\"Quoted phrase\""}, {"phrase": "Why do buses stop?"}, {"phrase": "more charging points"}, {"phrase": "has a \"quote\" inside"}, {"phrase": ""}, {"phrase": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"}, {"phrase": "x" * 91}, "junk", {"phrase": "Trailing marks;:!"}, {"phrase": "‘curly’"}]},
    {"items": [{"phrase": f"phrase number {i}"} for i in range(12)]},
    None,
    {"items": None},
]
for raw in raws:
    rec("shape_popcorn_items", [raw, "c1"], A.shape_popcorn_items(raw, "c1"))

names = {"Maria", "Jan", "Éva"}
for text in ["Maria said hi", "maria said hi", "Jan's idea", "Éva and Jan", "nothing", "Mariana is here"]:
    rec("name_hits", [text, sorted(names)], F.name_hits(text, names))
    rec("scrub_names", [text, sorted(names)], F.scrub_names(text, names))
for a, b in [("more charging points near flats", "charging points near the flats"), ("buses stop at eleven", "buses do not stop at eleven"), ("the", "a"), ("", "x")]:
    rec("jaccard", [a, b], F.jaccard(a, b))
    rec("negated", a, F.negated(a))
state = {"conversations": {"c1": {"items": [{"phrase": "we need more charging points near the flats today"}]}, "c2": {"items": [{"phrase": "buses stop running at eleven so people drive"}]}}, "analysis": {"tensions": {"tensions": [{"id": "x1", "poleA": "drive cars into the city center every day", "url": "one two three four five six seven", "quoteIds": ["q1"]}]}}}
rec("known_shingles", [state, None], sorted("\u0001".join(s) for s in F.known_shingles(state)))
rec("known_shingles", [state, "c1"], sorted("\u0001".join(s) for s in F.known_shingles(state, exclude="c1")))
known = F.known_shingles(state, exclude="c1")
items = [{"id": "p1", "phrase": "Maria wants chargers"}, {"id": "p2", "phrase": "buses stop running at eleven so people drive home"}, {"id": "p3", "phrase": "more charging points near flats"}, {"id": "p4", "phrase": "charging points near the flats"}, {"id": "p5", "phrase": "no charging points near the flats"}]
rec("gate_items", [items, sorted(names), sorted("\u0001".join(s) for s in known)], [list(x) for x in F.gate_items(copy.deepcopy(items), names=names, known=known)])

stakes = [
    {"stakeholders": [{"id": "s1", "name": "Staff and Volunteers"}, {"id": "s2", "name": "Residents, aged 65+"}, {"id": "s3", "name": "Staff, Volunteers"}, {"id": "s4", "name": "The AI"}, {"id": "s5", "name": "Users of the recording"}, {"id": "s6", "name": "Market pressure"}, {"id": "s7", "name": "Café's owner"}], "relations": [{"between": ["s1", "s2"]}, {"between": ["s4", "s5"]}]},
    {"stakeholders": [{"id": "s1", "name": "A"}, {"id": "s2", "name": "B"}], "relations": [{"between": ["s1", "s2"]}]},
    {"stakeholders": [{"id": "s1", "name": "It's"}, {"id": "s2"}], "relations": []},
]
for s in stakes:
    rec("name_flags", s, G.name_flags(s))
    rec("island_flags", s, G.island_flags(s))
tens = {"tensions": [
    {"id": "x1", "poleA": "one two", "poleB": "one two three four five six seven eight", "knot": "It is one. It is two.", "toResolve": ""},
    {"id": "x2", "poleA": "one two three", "poleB": "a b c", "knot": " ".join(["w"] * 19), "toResolve": " ".join(["q"] * 23)},
    {"id": "x3", "poleA": "one two three", "poleB": "a b c", "knot": "Participants discussed the thing.", "toResolve": "How do we feel that it works?"},
    {"poleA": "it's here now", "poleB": "a \"b\" c", "knot": None, "toResolve": "They acknowledged it"},
]}
rec("screen_flags", tens, G.screen_flags(tens))

transcript = texts[0] + "\n\nParking spaces are rare near the flats, and charging points even more so.\nNobody likes waiting lists."
for phrase in ["charging points near the flats", "waiting list months", "unrelated words entirely", "", "buses stop running", "the and of"]:
    rec("ground_items", [phrase, transcript], GR.ground_items([{"phrase": phrase}], transcript))
long_para = "charging points " + "word " * 120
rec("ground_items", ["charging points word", long_para], GR.ground_items([{"phrase": "charging points word"}], long_para))

sources = {"c1": texts[0], "c2": texts[1]}
existing = [{"id": "q3", "transcript": "c1", "text": "We need more charging points near the flats", "context": "Early on"}, {"id": "q9", "transcript": "c2", "text": "gone quote text here"}, {"id": "bad", "transcript": "c1", "text": "Buses stop running"}, {"id": "q4", "transcript": "c1", "text": "Buses stop running at eleven", "context": "When Maria spoke"}]
book = A.QuoteBook(sources, names={"Maria"}, existing=copy.deepcopy(existing))
adds = [{"transcript": "c1", "text": "Buses stop running at eleven"}, {"transcript": "c2", "text": "we need more charging points"}, {"transcript": "c1", "text": "not in any transcript"}, {"transcript": "c1", "text": "the waiting list is months long", "context": "a moment about Maria"}, {"transcript": "c2", "text": "What Anna was saying matters", "context": "Late in the conversation"}, {"text": ""}]
ids = [book.add(q) for q in adds]
rec("quote_book", [sources, ["Maria"], existing, adds], {"ids": ids, "quotes": book.quotes, "rejected": book.rejected, "reattributed": book.reattributed})

raw_stake = {"stakeholders": [
    {"name": "Residents", "role": "live near", "stake": "charging", "rung": "voiced", "stakeWeight": 0.855, "mentionsWeight": 1, "quotes": [{"transcript": "c1", "text": "We need more charging points"}, {"transcript": "c1", "text": "nope nope nope"}]},
    {"name": "Bus company", "role": "runs buses", "stake": "routes", "rung": "named", "invokedBy": "Residents", "stakeWeight": 0.125, "mentionsWeight": 0.5, "quotes": []},
    {"name": "residents", "role": "dup", "stake": "dup", "rung": "inferred", "stakeWeight": 0.3, "mentionsWeight": 0.2},
], "relations": [
    {"between": ["Residents", "Bus company"], "label": "depend", "intensity": 0.675, "sentiment": -0.5, "unowned": False, "detail": "d", "aspects": [{"kind": "risk", "note": "n", "quotes": [{"transcript": "c1", "text": "Buses stop running at eleven"}]}, {"kind": "power", "note": "n2", "quotes": [{"transcript": "c1", "text": "zzz not there"}]}]},
    {"between": ["Bus company", "Residents"], "label": "dup", "intensity": 0.1, "sentiment": 0, "unowned": True, "detail": "d", "aspects": []},
    {"between": ["Residents", "Nobody"], "label": "x", "intensity": 0.1, "sentiment": 0, "unowned": True, "detail": "d", "aspects": []},
    {"between": ["Residents"], "label": "x", "intensity": 0.1, "sentiment": 0, "unowned": True, "detail": "d", "aspects": []},
]}
book2 = A.QuoteBook(sources)
rec("shape_stakeholders", [sources, raw_stake], {"slide": A.shape_stakeholders(copy.deepcopy(raw_stake), book2), "quotes": book2.quotes})
for lengths, budget in [({"a": 10, "b": 20}, 100), ({"a": 10, "b": 200, "c": 200}, 110), ({"a": 50, "b": 50, "c": 5}, 60)]:
    rec("allocate_chars", [lengths, budget], A.allocate_chars(lengths, budget))

for raw, phrase, tr in [({"grounded": True, "quote": " We need more charging points ", "reason": " ok "}, "We can get more charging points", texts[0]), ({"grounded": True, "quote": "short", "reason": ""}, "x", texts[0]), ({"grounded": False, "quote": "We need more charging points", "reason": "no"}, "x", texts[0]), ({"grounded": True, "quote": "not there at all really", "reason": ""}, "x", texts[0])]:
    rec("evidence_from", [raw, phrase, tr], E.evidence_from(raw, phrase, tr))
for raw in [{"kind": "need", "qualifiers": ["tentative", "bogus"], "question_form": 1, "target": "Maria's plan", "reason": "Maria said so"}, {"kind": "question", "qualifiers": None}]:
    rec("kind_from", [raw, ["Maria"]], E.kind_from(raw, {"Maria"}))
try:
    E.kind_from({"kind": "nope"}, set())
except ValueError as exc:
    rec("kind_from_error", "nope", str(exc))
for p, q in [("It might often happen", "It happens sometimes"), ("Can we", "We could")]:
    rec("hedge_added", [p, q], E.hedge_added(p, q))
for p in ["Why do buses stop?", "Why?", "no mark", 'a "q"?', "x" * 90 + "?"]:
    rec("question_ok", p, E.question_ok(p))
items = [{"id": "p1", "phrase": "more charging points"}, {"id": "p2", "phrase": "buses stop", "quoteId": "q1", "review": {"errors": ["old"]}}, {"id": "p3", "phrase": "why buses stop"}, {"id": "p4", "phrase": "changed"}, {"id": "p5", "phrase": "untouched"}]
results = [
    {"id": "p1", "phrase": "more charging points", "errors": [], "evidence": {"grounded": True, "quote": "We need more charging points", "hedge_added": ["can"], "reason": "r1", "for": "x"}, "kind": {"kind": "need", "qualifiers": [], "question": False, "target": "t", "reason": "k1"}},
    {"id": "p2", "phrase": "buses stop", "errors": [], "evidence": {"grounded": False, "quote": "", "hedge_added": [], "reason": "r2", "for": "x"}},
    {"id": "p3", "phrase": "why buses stop", "errors": ["evidence: boom"], "kind": {"kind": "question", "qualifiers": ["tentative"], "question": True, "target": "", "reason": "k3"}, "rewritten": "Why do buses stop"},
    {"id": "p4", "phrase": "not the same", "errors": []},
]
its = copy.deepcopy(items)
reg = {"We need more charging points": "q7"}
stats = E.apply_results(its, results, transcript_id="c1", register=lambda tid, q: reg.get(q))
rec("apply_results", [items, results, reg], {"items": its, "stats": stats})

entry = {"fingerprint": "fp1", "items": [{"id": "p-a", "phrase": "Reviewed wording", "kind": "need", "question": False, "qualifiers": [], "review": {"kind": "k"}, "quoteId": "q1", "rooted": True}, {"id": "p-b", "phrase": "old b", "quoteId": "q2", "rooted": True}, {"id": "p-c", "phrase": "c", "kind": "idea", "rooted": False}], "review": {"dropped": [{"id": "p-d", "phrase": "d"}]}}
quotes = [{"id": "q1", "transcript": "c1", "text": "We need more charging points"}, {"id": "q2", "transcript": "c1", "text": "gone from transcript"}]
fresh_items = [{"id": "p-a", "phrase": "fresh a"}, {"id": "p-b", "phrase": "fresh b"}, {"id": "p-c", "phrase": "fresh c"}, {"id": "p-d", "phrase": "fresh d"}, {"id": "p-e", "phrase": "new e"}]
for fp in ["fp1", "fp2"]:
    rec("carry_forward", [fresh_items, entry, texts[0], quotes, fp], list(T._carry_forward(copy.deepcopy(fresh_items), copy.deepcopy(entry), texts[0], quotes, fingerprint=fp)))

prev = {"fingerprints": {"tensions": "old", "stakeholders": "old"}, "updated": {"tensions": "2026-01-01T00:00:00+00:00", "stakeholders": "2026-01-02T00:00:00+00:00"}, "tensions": {"tensions": [{"quoteIds": ["q1"]}]}, "stakeholders": {"stakeholders": [{"quoteIds": ["q9"]}]}}
for fresh in [{"tensions": None, "stakeholders": None}, {"tensions": {"tensions": []}, "stakeholders": None}, {"tensions": None, "stakeholders": {"stakeholders": [{"quoteIds": ["q1"]}]}}]:
    st = {"analysis": copy.deepcopy(prev)}
    outc = []
    T._commit_views(st, copy.deepcopy(fresh), analysis_fingerprint="new", held_quotes={"q1"}, outcomes=outc)
    rec("commit_views", [prev, fresh, ["q1"]], {"analysis": st["analysis"], "outcomes": outc})
st = {"analysis": None}
T._commit_views(st, {"tensions": None, "stakeholders": None}, analysis_fingerprint="n", held_quotes=set(), outcomes=[])
rec("commit_views", [None, {"tensions": None, "stakeholders": None}, []], {"analysis": st["analysis"], "outcomes": []})
rec("stale_views", [prev, "old"], T._stale_views({"analysis": prev}, "old"))
rec("stale_views", [prev, "new"], T._stale_views({"analysis": prev}, "new", ("tensions",)))
for s in [{}, {"presentation": {"blocks": ["popcorn", "stakeholders"]}}, {"presentation": {}}]:
    rec("selected_views", s, list(T._selected_analysis_views(s)))
json.dump(out, sys.stdout, ensure_ascii=False, indent=1, default=str)
