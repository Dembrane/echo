import { describe, expect, test } from "bun:test";
import { applyPublishedObjects, type DeckObjects, type DeckRevision } from "../src/deck";
import type { Json } from "../src/py";

const args = {
  settings: { tabs: { tensions: true, stakeholders: true } },
  project: {},
  host: false,
};

const phrase = (conversationId: string, quote: string): DeckRevision => ({
  id: `rev-${conversationId}`,
  objectId: `obj-${conversationId}`,
  type: "popcorn",
  payload: { phrase: "a phrase", evidence: [{ conversationId, quotes: [quote] }] },
  sourceConversationIds: [conversationId],
  extra: {},
});

const objects = (over: Partial<DeckObjects> = {}): DeckObjects => ({
  popcorn: new Map([["c3", [phrase("c3", "something else entirely")]]]),
  tensions: [],
  stakeholders: [],
  relations: [],
  ownsTensions: false,
  ownsStakeholders: false,
  ...over,
});

// The session's own bundle: its registry numbers from q1, as the deck's does.
const sessionBundle = (): Json => ({
  files: {
    "quotes.json": {
      quotes: [
        { id: "q1", transcript: "c1", text: "we need buses at night" },
        { id: "q2", transcript: "c2", text: "no money for staff" },
      ],
    },
    "tensions.json": { tensions: [{ id: "t1", poleA: "a", poleB: "b", quoteIds: ["q1", "q2"] }] },
    "stakeholders.json": {
      stakeholders: [{ id: "s1", name: "Staff", quoteIds: ["q2"] }],
      relations: [{ id: "r1", aspects: [{ kind: "k", quoteIds: ["q1"] }] }],
    },
  },
});

const resolve = (files: Json, ids: unknown) => {
  const registry = new Map(((files["quotes.json"] as Json).quotes as Json[]).map((q) => [q.id, q]));
  return (ids as string[]).map((id) => {
    const q = registry.get(id);
    return q ? `${q.transcript}: ${q.text}` : null;
  });
};

describe("the deck's quotes registry beside the session's slides", () => {
  test("a session tension's quotes resolve to the words it cited, not the deck's own", () => {
    const files = applyPublishedObjects(sessionBundle(), objects(), args).files as Json;
    const tension = ((files["tensions.json"] as Json).tensions as Json[])[0] as Json;
    expect(resolve(files, tension.quoteIds)).toEqual([
      "c1: we need buses at night",
      "c2: no money for staff",
    ]);
  });

  test("session stakeholders and their aspects resolve the same way", () => {
    const files = applyPublishedObjects(sessionBundle(), objects(), args).files as Json;
    const slide = files["stakeholders.json"] as Json;
    const person = (slide.stakeholders as Json[])[0] as Json;
    const aspect = ((slide.relations as Json[])[0] as Json).aspects as Json[];
    expect(resolve(files, person.quoteIds)).toEqual(["c2: no money for staff"]);
    expect(resolve(files, (aspect[0] as Json).quoteIds)).toEqual(["c1: we need buses at night"]);
  });

  test("the deck's own phrases keep their quotes", () => {
    const files = applyPublishedObjects(sessionBundle(), objects(), args).files as Json;
    const item = ((files["popcorn/c3.json"] as Json).items as Json[])[0] as Json;
    expect(resolve(files, [item.quoteId])).toEqual(["c3: something else entirely"]);
  });

  test("a quote the session and the deck both cite is listed once", () => {
    const deck = objects({ popcorn: new Map([["c2", [phrase("c2", "no money for staff")]]]) });
    const files = applyPublishedObjects(sessionBundle(), deck, args).files as Json;
    const item = ((files["popcorn/c2.json"] as Json).items as Json[])[0] as Json;
    const tension = ((files["tensions.json"] as Json).tensions as Json[])[0] as Json;
    expect((tension.quoteIds as string[])[1]).toBe(item.quoteId as string);
    expect(((files["quotes.json"] as Json).quotes as Json[]).length).toBe(2);
  });
});
