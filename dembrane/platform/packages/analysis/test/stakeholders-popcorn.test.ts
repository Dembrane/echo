import { expect, test } from "bun:test";
import type { Json } from "../src/contracts";
import { sourceRefJson } from "../src/contracts";
import { contentHash } from "../src/hashing";
import type { Transcript } from "../src/maprecipe";
import { groundPhrases, phraseKey, phraseRecords } from "../src/recipes/popcorn";
import {
  allocateChars,
  buildCorpus,
  islandFlags,
  nameFlags,
  pyRound2,
  QuoteBook,
  shapeStakeholders,
  transcriptMessage,
} from "../src/recipes/popcorn-shared";
import {
  feedbackPrompt,
  lineageKey,
  quoteRefs,
  relationAttributes,
  STAKEHOLDERS_PROMPT_TEXT,
  sourceRefs,
  stakeholderPayload,
} from "../src/recipes/stakeholders";
import { normKey, sha256Hex } from "../src/text";
import { validatePayload, validateRelation } from "../src/types";
import recorded from "./fixtures/python-stakeholders-popcorn.json" with { type: "json" };

// Everything expected below is what the Python stakeholders and popcorn recipes computed
// for the same inputs and recorded model answers (python-stakeholders-popcorn.json).
const S = recorded.stakeholders as unknown as Json;
const P = recorded.popcorn as unknown as Json;
const transcripts = S.transcripts as unknown as Transcript[];
const texts = Object.fromEntries(transcripts.map((t) => [t.id, t.text]));
const keys = new Map(transcripts.map((t) => [t.id, normKey(t.text)]));
const hashes = new Map(transcripts.map((t) => [t.id, sha256Hex(t.text)]));

test("the corpus, prompts and gates match the Python pipeline", () => {
  expect(allocateChars({ a: 10, b: 500, c: 50, d: 1000 }, 700)).toEqual(
    S.allocate as Record<string, number>,
  );
  const user = transcriptMessage("session", buildCorpus(Object.entries(texts)));
  expect(user).toBe(String(S.userText));
  expect(sha256Hex(STAKEHOLDERS_PROMPT_TEXT)).toBe(String(S.systemSha));
  const probe = shapeStakeholders(S.first as Json, new QuoteBook(texts));
  expect(probe as unknown).toEqual(S.probe);
  const flags = [...nameFlags(probe), ...islandFlags(probe)];
  expect(flags).toEqual(S.flags as string[]);
  expect(sha256Hex(feedbackPrompt(STAKEHOLDERS_PROMPT_TEXT, flags))).toBe(String(S.feedbackSha));
  for (const c of S.flagCases as Json[]) expect(nameFlags(c.in as Json)).toEqual(c.out as string[]);
  expect(islandFlags((S.islandCase as Json).in as Json)).toEqual(
    (S.islandCase as Json).out as string[],
  );
});

test("the retried answer becomes the payloads, relations and hashes Python published", () => {
  const book = new QuoteBook(texts);
  const slide = shapeStakeholders(S.retry as Json, book);
  expect(slide as unknown).toEqual(S.slide);
  expect(book.quotes as unknown).toEqual(S.quotes);
  expect([...nameFlags(slide), ...islandFlags(slide)]).toEqual(S.left as string[]);
  const bq = new Map(book.quotes.map((q) => [q.id, q]));
  const expected = S.payloads as Record<string, Json>;
  for (const person of slide.stakeholders) {
    const want = expected[String(person.id)] as Json;
    const payload = validatePayload("stakeholder", stakeholderPayload(person, bq, keys));
    expect(JSON.parse(JSON.stringify(payload))).toEqual(want.payload as Json);
    // Weights are floats in Python (1.0, 0.0): the hash proves they are hashed as floats.
    expect(contentHash(payload)).toBe(String(want.hash));
    expect(lineageKey(String(person.name))).toBe(String(want.lineage));
    const refs = sourceRefs(((person.quoteIds as string[]) ?? []).map(String), bq, keys, hashes);
    expect(refs.map(sourceRefJson)).toEqual(want.sourceRefs as Json[]);
  }
  const relations = S.relations as Json[];
  expect(slide.relations.length).toBe(relations.length);
  slide.relations.forEach((r, i) => {
    const want = relations[i] as Json;
    const attrs = validateRelation("stakeholder_relation", {
      fromType: "stakeholder",
      toType: "stakeholder",
      basis: "extracted",
      attributes: relationAttributes(r, bq, keys),
    });
    expect(JSON.parse(JSON.stringify(attrs))).toEqual(want.attributes as Json);
    expect(contentHash(attrs)).toBe(String(want.hash));
    const qids = ((r.aspects as Json[]) ?? []).flatMap((a) => (a.quoteIds as string[]) ?? []);
    expect(sourceRefs(qids, bq, keys, hashes).map(sourceRefJson)).toEqual(
      want.sourceRefs as Json[],
    );
  });
  expect(quoteRefs(["q404"], bq, keys)).toEqual([]);
});

test("rounding follows Python's round(x, 2)", () => {
  expect(pyRound2(0.125)).toBe(0.12);
  expect(pyRound2(0.375)).toBe(0.38);
  expect(pyRound2(2.675)).toBe(2.67);
  expect(pyRound2(0.333)).toBe(0.33);
  expect(pyRound2(-0.456)).toBe(-0.46);
});

test("popcorn phrases, grounding and payloads match the Python recipe", () => {
  const quotes = new Map(Object.entries(P.quotes as Record<string, Json>));
  const records = phraseRecords(P.items, quotes);
  expect(records).toEqual(P.records as Json[]);
  const { grounded } = groundPhrases(records, String(P.text));
  expect(grounded).toEqual(P.grounded as Json[]);
  const C1 = "c1000000-0000-4000-8000-000000000001";
  grounded.forEach((p, i) => {
    const want = (P.payloads as Json[])[i] as Json;
    const quote = p.quote as string | null;
    const payload = validatePayload("popcorn", {
      phrase: p.phrase,
      question: Boolean(p.question),
      language: null,
      evidence: [
        {
          conversationId: C1,
          label: "Resident 1",
          createdAt: transcripts[0]?.createdAt,
          quotes: quote ? [quote] : [],
        },
      ],
    });
    expect(contentHash(payload)).toBe(String(want.hash));
    expect(`${C1}:${phraseKey(String(p.phrase))}`).toBe(String(want.lineage));
  });
});
