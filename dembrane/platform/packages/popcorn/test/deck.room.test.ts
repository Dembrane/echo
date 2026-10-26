import { describe, expect, test } from "bun:test";
import {
  applyPublishedObjects,
  applyResultBindings,
  type DeckAnalysis,
  type DeckObjects,
  type DeckRevision,
  deckQuoteId,
  NO_OBJECTS,
} from "../src/deck";
import type { Json } from "../src/py";

/**
 * What the room may be shown, as rules every built deck keeps. Each rule closes a way the
 * room and the host's results came apart: a slide the session held with no objects behind
 * it (the tensions the results table could not list), and quote ids numbered by position
 * (a screen that kept one conversation's file from an earlier read showed another
 * conversation's quotes beside its phrases).
 */

const args = {
  settings: { tabs: { tensions: true, stakeholders: true } },
  project: {},
  host: false,
};

let serial = 0;
const phrase = (conversationId: string, quote: string, words = `about ${quote}`): DeckRevision => {
  serial++;
  return {
    id: `rev-${serial}`,
    objectId: `obj-${conversationId}-${serial}`,
    type: "popcorn",
    recipeId: "popcorn",
    payload: { phrase: words, evidence: [{ conversationId, quotes: [quote] }] },
    sourceConversationIds: [conversationId],
    extra: { phraseId: `p-${conversationId}-${serial}` },
  };
};

const tension = (objectId: string, quotes: [string, string, "A" | "B"][]): DeckRevision => ({
  id: `rev-${objectId}`,
  objectId,
  type: "tension",
  recipeId: "popcorn.tensions",
  payload: {
    poleA: `${objectId} A`,
    poleB: `${objectId} B`,
    knot: "k",
    toResolve: "r",
    quotes: quotes.map(([conversationId, text, pole]) => ({ conversationId, text, pole })),
  },
  sourceConversationIds: quotes.map(([c]) => c),
  extra: { identity: `id-${objectId}` },
});

const stakeholder = (objectId: string, name: string, stake: number): DeckRevision => ({
  id: `rev-${objectId}`,
  objectId,
  type: "stakeholder",
  recipeId: "stakeholders",
  payload: {
    name,
    role: "r",
    stake: "s",
    rung: "voiced",
    weight: { stake, mentions: 0.5 },
    quotes: [{ conversationId: "c1", text: `${name} said so` }],
  },
  sourceConversationIds: ["c1"],
  extra: {},
});

const objects = (over: Partial<DeckObjects> = {}): DeckObjects => ({
  popcorn: new Map(),
  tensions: [],
  stakeholders: [],
  relations: [],
  ownsTensions: false,
  ownsStakeholders: false,
  ...over,
});

// The session's own files: its registry numbers from q1, by the order it met the quotes.
const sessionBundle = (over: Json = {}): Json => ({
  files: {
    "session.json": { title: "t", transcripts: [] },
    "quotes.json": {
      quotes: [
        { id: "q1", transcript: "c1", text: "we need buses at night" },
        { id: "q2", transcript: "c2", text: "no money for staff" },
      ],
    },
    "popcorn/c1.json": { transcript: "c1", items: [{ id: "p1", phrase: "buses", quoteId: "q1" }] },
    "popcorn/c2.json": { transcript: "c2", items: [{ id: "p2", phrase: "staff", quoteId: "q2" }] },
    "tensions.json": { tensions: [{ id: "x1", poleA: "a", poleB: "b", quoteIds: ["q1", "q2"] }] },
    "stakeholders.json": {
      stakeholders: [{ id: "s1", name: "Staff", quoteIds: ["q2"] }],
      relations: [],
    },
    ...over,
  },
});

const registry = (files: Json) =>
  new Map(
    (((files["quotes.json"] as Json | undefined)?.quotes as Json[] | undefined) ?? []).map((q) => [
      String(q.id),
      q,
    ]),
  );

/**
 * The rules, checked over one built deck. Returns what broke, so a failure names it.
 * - every tension and stakeholder on a published deck is an object, by its object id
 * - every phrase is an object, or its whole file is marked provisional
 * - every quote id resolves, and a phrase's quote is its own conversation's
 * - every quote id is the one its words and conversation derive
 */
function broken(files: Json, published: boolean): string[] {
  const out: string[] = [];
  const quotes = registry(files);
  const cite = (where: string, id: unknown, conversation?: string) => {
    const q = quotes.get(String(id));
    if (!q) return out.push(`${where}: quote ${String(id)} is not in the registry`);
    if (conversation && q.transcript !== conversation)
      out.push(`${where}: quote of ${String(q.transcript)} beside ${conversation}'s phrase`);
    if (id !== deckQuoteId(String(q.transcript), String(q.text)))
      out.push(`${where}: quote id ${String(id)} is not derived from its words`);
  };
  for (const [name, raw] of Object.entries(files)) {
    const file = raw as Json;
    if (name.startsWith("popcorn/")) {
      const conversation = name.slice("popcorn/".length, -".json".length);
      for (const item of (file.items as Json[] | undefined) ?? []) {
        if (published && !item.objectId && file.provisional !== true)
          out.push(`${name}: phrase ${String(item.id)} has no object and is not provisional`);
        if (item.quoteId) cite(name, item.quoteId, conversation);
      }
    }
    for (const key of ["tensions", "stakeholders"] as const)
      if (name === `${key}.json`)
        for (const item of (file[key] as Json[] | undefined) ?? []) {
          if (published && (!item.objectId || item.id !== item.objectId))
            out.push(`${name}: ${String(item.id)} is not named by its object`);
          for (const id of (item.quoteIds as unknown[] | undefined) ?? []) cite(name, id);
        }
  }
  return out;
}

describe("once a session publishes, the room shows only published objects", () => {
  const deck = () =>
    objects({ popcorn: new Map([["c3", [phrase("c3", "something else entirely")]]]) });

  test("a tension or stakeholder slide with no objects behind it leaves the room", () => {
    const files = applyPublishedObjects(sessionBundle(), deck(), args).files as Json;
    expect(files["tensions.json"]).toBeUndefined();
    expect(files["stakeholders.json"]).toBeUndefined();
    expect(broken(files, true)).toEqual([]);
  });

  test("a conversation not published yet is provisional, its quotes still its own", () => {
    const files = applyPublishedObjects(sessionBundle(), deck(), args).files as Json;
    expect((files["popcorn/c1.json"] as Json).provisional).toBe(true);
    expect((files["popcorn/c3.json"] as Json).provisional).toBeUndefined();
    expect(broken(files, true)).toEqual([]);
  });

  test("published tensions and stakeholders are named by their objects", () => {
    const people = [stakeholder("o-staff", "Staff", 0.9), stakeholder("o-riders", "Riders", 0.4)];
    const built = objects({
      popcorn: deck().popcorn,
      tensions: [tension("o-t2", [["c1", "we need buses at night", "A"]]), tension("o-t1", [])],
      stakeholders: people,
      relations: [
        { fromRevisionId: "rev-o-staff", toRevisionId: "rev-o-riders", attributes: {} },
        { fromRevisionId: "rev-o-staff", toRevisionId: "rev-o-riders", attributes: {} },
      ],
      ownsTensions: true,
      ownsStakeholders: true,
    });
    const files = applyPublishedObjects(sessionBundle(), built, args).files as Json;
    const tensions = (files["tensions.json"] as Json).tensions as Json[];
    expect(tensions.map((t) => t.id)).toEqual(["o-t1", "o-t2"]);
    const [, pole] = tensions;
    expect(pole?.identity).toBe("id-o-t2");
    expect(Object.values(pole?.quotePoles as Json)).toEqual(["A"]);
    const slide = files["stakeholders.json"] as Json;
    expect((slide.stakeholders as Json[]).map((s) => s.id)).toEqual(["o-staff", "o-riders"]);
    expect((slide.relations as Json[]).map((r) => r.id)).toEqual([
      "o-staff~o-riders",
      "o-staff~o-riders~1",
    ]);
    expect(broken(files, true)).toEqual([]);
  });

  test("a synthetic demo has no objects and keeps its own slides", () => {
    const demo = sessionBundle({ "session.json": { title: "t", demo: { synthetic: true } } });
    const files = applyPublishedObjects(demo, deck(), args).files as Json;
    expect(files["tensions.json"]).toBeDefined();
    expect(broken(files, false)).toEqual([]);
  });

  test("before anything is published the session's slides stand, with derived quote ids", () => {
    const files = applyPublishedObjects(sessionBundle(), NO_OBJECTS, args).files as Json;
    expect(files["tensions.json"]).toBeDefined();
    const t = ((files["tensions.json"] as Json).tensions as Json[])[0] as Json;
    expect(t.quoteIds).toEqual([
      deckQuoteId("c1", "we need buses at night"),
      deckQuoteId("c2", "no money for staff"),
    ]);
    expect(broken(files, false)).toEqual([]);
  });
});

describe("a quote id means the same quote in every read", () => {
  // Tonight's case: conversations 3 and 4 published, then the deck was rebuilt with more
  // objects read before them. Numbered ids moved; a screen that kept conversation 4's file
  // showed conversation 3's quotes.
  const c3 = [phrase("c3", "three one"), phrase("c3", "three two")];
  const c4 = [phrase("c4", "four one"), phrase("c4", "four two")];
  const build = (popcorn: [string, DeckRevision[]][]) =>
    applyPublishedObjects({ files: {} }, objects({ popcorn: new Map(popcorn) }), args)
      .files as Json;

  test("a later read, with more published and in another order, keeps every id", () => {
    const first = build([
      ["c3", c3],
      ["c4", c4],
    ]);
    const later = build([
      ["c7", [phrase("c7", "seven")]],
      ["c4", c4],
      ["c3", [...c3, phrase("c3", "three three")]],
    ]);
    const kept = (first["popcorn/c4.json"] as Json).items as Json[];
    const quotes = registry(later);
    for (const item of kept) {
      const q = quotes.get(String(item.quoteId));
      expect(q?.transcript).toBe("c4");
    }
    expect(broken(first, true)).toEqual([]);
    expect(broken(later, true)).toEqual([]);
  });
});

describe("a pinned slide is a snapshot of objects", () => {
  const pinned = objects({
    tensions: [tension("o-pin", [["c1", "we need buses at night", "B"]])],
    ownsTensions: true,
  });
  const deck = {
    deckObjects: async (_p: string, snapshotId?: string | null) =>
      snapshotId === "snap-1" ? pinned : NO_OBJECTS,
  } as unknown as DeckAnalysis;
  const settings = (binding: string) => ({
    tabs: { tensions: true },
    presentation: { result_bindings: { tensions: binding } },
  });
  const live = () =>
    applyPublishedObjects(
      { files: {} },
      objects({
        popcorn: new Map([["c1", [phrase("c1", "we need buses at night")]]]),
        tensions: [tension("o-live", [])],
        ownsTensions: true,
      }),
      args,
    );

  test("an analysis pin shows the pinned objects, its quotes merged by id", async () => {
    const out = await applyResultBindings(live(), {
      settings: settings("analysis:snap-1"),
      projectId: "p",
      deck,
    });
    const files = out.files as Json;
    expect(((files["tensions.json"] as Json).tensions as Json[]).map((t) => t.id)).toEqual([
      "o-pin",
    ]);
    // The phrase and the pinned tension cite one quote: it is listed once.
    expect(((files["quotes.json"] as Json).quotes as Json[]).length).toBe(1);
    expect(broken(files, true)).toEqual([]);
  });

  test("a pin to a saved session copy is not honoured: the slide follows the objects", async () => {
    const out = await applyResultBindings(live(), {
      settings: settings("01a179c8-232e-7478-98c1-096881de3842"),
      projectId: "p",
      deck,
    });
    const files = out.files as Json;
    expect(((files["tensions.json"] as Json).tensions as Json[]).map((t) => t.id)).toEqual([
      "o-live",
    ]);
  });
});
