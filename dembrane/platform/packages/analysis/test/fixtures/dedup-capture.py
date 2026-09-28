# Records the Python deduplication core on fixed inputs and a recording fake verifier.
import asyncio, json, sys
from dataclasses import asdict
from dembrane.analysis.recipes import deduplication as d
from dembrane.analysis.hashing import content_hash

def src(rid, stmt, kind, val, vec, quotes):
    return d.SourceArgument(revision_id=rid, object_id="o-" + rid, statement=stmt, epistemic_kind=kind,
        valence=val, evidence=[d.Evidence(conversation_id=c, quote=q) for c, q in quotes], embedding=vec,
        embedding_config_key="cfg-1")

SOURCES = [
    src("r01", "Rents are  too high.", "claim", "negative", [1, 0, 0, 0.1], [("c1", "rent is crazy"), ("c1", "Rent is crazy")]),
    src("r02", "rents are too high.", "claim", "negative", [1, 0, 0, 0.1], [("c2", "we pay half our income")]),
    src("r03", "More buses at night.", "argument", "positive", [0, 1, 0.05, 0], [("c1", "buses stop at eleven")]),
    src("r04", "Night buses should run later.", "argument", "positive", [0, 1, 0.1, 0.02], [("c2", "last bus is too early"), ("c3", "q3a"), ("c3", "q3b")]),
    src("r05", "Buses should be free.", "argument", "positive", [0, 0.9, 0.3, 0], [("c3", "make buses free")]),
    src("r06", "Parks need lights.", "argument", "negative", [0, 0, 1, 0], [("c1", "the park is dark")]),
    src("r07", "Lighting in parks is poor.", "argument", "negative", [0, 0.05, 1, 0.01], [("c2", "cannot see a thing")]),
    src("r08", "The market is fine.", "argument", "neutral", [0.3, 0.3, 0.3, 0.3], [("c4", "it is ok")]),
    src("r09", "Crime went up.", "claim", "positive", [0.5, 0.5, 0, 1], [("c1", "more thefts")]),
    src("r10", "Crime has risen.", "claim", "positive", [0.5, 0.52, 0, 1], [("c2", "thefts doubled")]),
]

def answers_for(requests):
    out = {}
    for req in requests:
        labels = [m.label for m in req.members]
        stmts = [m.statement for m in req.members]
        if any("buses" in s.lower() for s in stmts):
            if len(labels) == 3:
                out[req.group_id] = {"groups": [
                    {"members": ["m1", "m2"], "proposed_statement": " Night buses should   run later. ", "checks": [
                        {"member": "m1", "judgement": "equivalent", "note": "same  ask"},
                        {"member": "m2", "judgement": "equivalent", "note": "same"}], "verdict": "equivalent", "rationale": "Both ask for later buses."},
                    {"members": ["m3"], "proposed_statement": "Buses should be free.", "checks": [], "verdict": "not_equivalent", "rationale": "Different ask."}]}
            else:
                out[req.group_id] = {"groups": [{"members": labels, "proposed_statement": "Night buses should run later.", "checks": [
                    {"member": l, "judgement": "equivalent", "note": ""} for l in labels], "verdict": "equivalent", "rationale": "Same."}]}
        elif any("park" in s.lower() or "lighting" in s.lower() for s in stmts):
            out[req.group_id] = {"groups": [{"members": ["m1"], "proposed_statement": "x", "checks": [], "verdict": "uncertain", "rationale": "r"}]}
        else:
            out[req.group_id] = None  # verifier raises
    return out

async def run_case(name, params):
    disc = d.discover_candidates(SOURCES, params)
    by = {s.revision_id: s for s in SOURCES}
    reqs = [d.build_request(g, by) for g in disc.groups]
    answers = answers_for(reqs)
    async def verifier(req):
        a = answers[req.group_id]
        if a is None:
            raise RuntimeError("boom")
        return a, {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "attempts": 1}
    result = await d.deduplicate(SOURCES, params, verifier)
    discovery_doc = {"units": [list(u) for u in disc.units], "groups": [asdict(g) for g in disc.groups],
                     "skipped": [asdict(g) for g in disc.skipped], "coverage": asdict(disc.coverage)}
    rd = result.as_dict()
    return {"name": name, "params": asdict(params), "answers": answers,
            "userTexts": {r.group_id: d.verification_user_text(r) for r in reqs},
            "discovery": discovery_doc, "discoveryHash": content_hash(discovery_doc),
            "result": rd, "resultHash": content_hash(rd),
            "lineageKeys": [d.lineage_key(i.member_object_ids) for i in result.items],
            "statuses": [d.verification_status(i.verification) for i in result.items]}

async def main():
    cases = [
        await run_case("calibrated", d.DeduplicationParams(embedding_model="vertex_ai/text-embedding-004")),
        await run_case("limits", d.DeduplicationParams(embedding_model="text-embedding-004", max_group_size=2, max_candidate_groups=2)),
        await run_case("override", d.DeduplicationParams(embedding_model="unknown", similarity_threshold=1.0)),
        await run_case("uncalibrated", d.DeduplicationParams(embedding_model="other-model")),
    ]
    sources = [asdict(s) for s in SOURCES]
    print(json.dumps({"promptFingerprint": d.prompt_fingerprint(), "sources": sources, "cases": cases}, indent=1))

asyncio.run(main())
