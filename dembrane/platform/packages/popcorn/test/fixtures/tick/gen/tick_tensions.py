"""The tensions pipeline over three transcripts with scripted judgements that exercise
ranking, the per-table reservation, unsupported pairs, facets folding in both ways and
the write retry; records every call and the result."""
import asyncio, json, sys, re, copy
from dembrane.popcorn import tensions as TP
from dembrane.popcorn.analysis import QuoteBook
from dembrane.popcorn.model import prompt_text

transcripts = {
    "t1": "We need more charging points near the flats.\nParking is already too scarce for residents.\nI would rather walk if the paths were safe.",
    "t2": "Buses stop running at eleven at night.\nThe council should cut car lanes for buses.\nCars are how the nurses get home.",
    "t3": "Night buses would help the late shift.\nMore chargers will just bring more cars.",
}
prompts = {name: prompt_text(name) for name in TP.PROMPT_NAMES}
CALLS = []

async def generate(*, system_prompt, user_text, schema, thinking):
    out = answer(system_prompt, user_text)
    CALLS.append({"system": system_prompt, "user": user_text, "thinking": thinking, "answer": out})
    return copy.deepcopy(out)

def answer(system, user):
    if system == prompts["tensions-handed"]:
        return {"handed": [{"text": "The council plan", "quote": "The council should cut car lanes for buses", "transcript": "t9", "response": "argued", "status": "argued"}, "junk"]}
    if system == prompts["positions"]:
        tid = re.search(r"TRANSCRIPT id: (\w+)", user).group(1)
        lines = [l for l in transcripts[tid].split("\n")]
        return {"positions": [{"position": f"{tid} wants {l[:25]}", "holder": "resident", "kind": "want", "hedged": i == 2, "quote": l if i != 1 or tid != "t3" else "not verbatim"} for i, l in enumerate(lines)] + ["x", {"position": ""}]}
    if system == prompts["collisions"]:
        focal = user.rsplit("FOCAL POSITION: ", 1)[1]
        n = int(focal[1:])
        return {"collides": [{"id": f"P{(n % 8) + 1}", "why": f"clash {n}", "zero_sum": 0.3 + (n % 5) / 10}, {"id": f"P{((n + 3) % 8) + 1}", "why": f"other {n}", "zero_sum": "0.9" if n == 2 else 0.1}, {"id": "P2", "why": "dup", "zero_sum": 0.95 if n == 5 else 0.21}]}
    if system == prompts["tension-verify"]:
        a = re.search(r'A \(.*?\): (.*)\n   said: "(.*)"', user)
        b = re.search(r'B \(.*?\): (.*)\n   said: "(.*)"', user)
        valid = "clash 3" not in user
        return {"valid": valid, "why": "because", "poleA": ("Pole " + a.group(1))[:40], "poleB": ("Pole " + b.group(1))[:40] if "clash 4" not in user else "", "quotesA": [a.group(2)], "quotesB": [b.group(2)] if "clash 6" not in user else []}
    if system == TP.DEDUPE_SYSTEM:
        kept = re.findall(r"^(x\d+): ", user, re.M)
        if len(kept) >= 2 and "clash 7" in user:
            return {"same_as": kept[0], "swapped": True, "why": "facet"}
        if "clash 8" in user:
            return {"same_as": kept[-1], "swapped": False, "why": "same"}
        return {"same_as": "", "swapped": False, "why": "new"}
    if system.startswith(prompts["tension-write"]):
        retry = system != prompts["tension-write"]
        pa = re.search(r"POLE A: (.*)", user).group(1)
        if not retry and "x1" not in user and "FACETS" in user:
            return {"poleA": "", "poleB": "x", "knot": "One. Two.", "toResolve": ""}
        return {"poleA": pa[:40], "poleB": "", "knot": "The pull is real here.", "toResolve": "What comes first for the street?"}
    raise RuntimeError("unscripted")

async def main():
    book = QuoteBook(transcripts, existing=[{"id": "q5", "transcript": "t1", "text": "Parking is already too scarce for residents"}])
    result = await TP.run_pipeline(transcripts, book, generate=generate, prompts=prompts, concurrency=3, max_tensions=3)
    json.dump({"transcripts": transcripts, "result": result, "quotes": book.quotes, "calls": CALLS}, sys.stdout, ensure_ascii=False, indent=1)
asyncio.run(main())
