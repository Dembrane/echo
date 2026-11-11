import { expect, test } from "bun:test";
import { type ExecutorDeps, normKey, pyFind, type SessionTension } from "@dembrane/analysis";
import type { Logger } from "@dembrane/observability";
import type { DeckAnalysis, DeckRevision } from "../src/deck";
import type { Json } from "../src/py";
import { carriedIdentities, Publisher } from "../src/tick/publish";
import { publishTensions, unpublishedTensions } from "../src/tick/run";
import { QuoteBook } from "../src/tick/shapes";

// Which published tension a newly read one is: the passages its poles rest on, not its words.
const transcripts: Json[] = [
  {
    id: "c1",
    text: "Staff must be able to say no. Not consent on paper and then the manager looks.",
  },
  {
    id: "c2",
    text: "Consent can look stronger than it is. Someone who says yes at the door is not free.",
  },
];
const at = (cid: string, text: string) =>
  pyFind(normKey(transcripts.find((t) => t.id === cid)?.text), normKey(text));

const published = (identity: string, quotes: [string, string, "A" | "B"][]): DeckRevision => ({
  id: `rev-${identity}`,
  objectId: `obj-${identity}`,
  type: "tension",
  recipeId: "popcorn.tensions",
  payload: {
    poleA: "a",
    poleB: "b",
    quotes: quotes.map(([cid, text, pole]) => ({
      text,
      conversationId: cid,
      location: { offset: at(cid, text), basis: "collapsed-casefold-v1" },
      pole,
    })),
  },
  sourceConversationIds: [],
  extra: { identity },
});

const read = (identity: string, quotes: [string, string, "A" | "B"][]): SessionTension => ({
  identity,
  poleA: "reworded a",
  poleB: "reworded b",
  knot: "",
  toResolve: "",
  quotes: quotes.map(([conversationId, text, pole]) => ({ text, conversationId, pole })),
});

const consent = published("old", [
  ["c1", "Staff must be able to say no.", "A"],
  ["c2", "Consent can look stronger than it is.", "B"],
]);

test("a tension on the same passages keeps the published identity, quotes said at more length", () => {
  const [t] = carriedIdentities(
    [
      read("new", [
        ["c1", "Staff must be able to say no. Not consent on paper", "A"],
        ["c2", "Consent can look stronger than it is. Someone who says yes", "B"],
      ]),
    ],
    [consent],
    transcripts,
  );
  expect(t?.identity).toBe("old");
});

test("poles written the other way round are the same tension", () => {
  const [t] = carriedIdentities(
    [
      read("new", [
        ["c2", "Consent can look stronger than it is.", "A"],
        ["c1", "Staff must be able to say no.", "B"],
      ]),
    ],
    [consent],
    transcripts,
  );
  expect(t?.identity).toBe("old");
});

test("one side on the same passage is not enough: the tension is a new one", () => {
  const [t] = carriedIdentities(
    [
      read("new", [
        ["c1", "Staff must be able to say no.", "A"],
        ["c2", "Someone who says yes at the door is not free.", "B"],
      ]),
    ],
    [consent],
    transcripts,
  );
  expect(t?.identity).toBe("new");
});

test("a published identity is taken once: by its own tension first, then by rank", () => {
  const same = [
    ["c1", "Staff must be able to say no.", "A"],
    ["c2", "Consent can look stronger than it is.", "B"],
  ] as [string, string, "A" | "B"][];
  const out = carriedIdentities(
    [read("first", same), read("second", same), read("old", same)],
    [consent],
    transcripts,
  );
  expect(out.map((t) => t.identity)).toEqual(["first", "second", "old"]);
  const ranked = carriedIdentities(
    [read("first", same), read("second", same)],
    [consent],
    transcripts,
  );
  expect(ranked.map((t) => t.identity)).toEqual(["old", "second"]);
});

test("of two published tensions on overlapping passages, the one sharing more words is the same", () => {
  const near = published("near", [
    ["c1", "Not consent on paper and then the manager looks.", "A"],
    ["c2", "Someone who says yes at the door is not free.", "B"],
  ]);
  const [t] = carriedIdentities(
    [
      read("new", [
        ["c1", "Staff must be able to say no. Not consent", "A"],
        ["c2", "Consent can look stronger than it is. Someone", "B"],
      ]),
    ],
    [near, consent],
    transcripts,
  );
  expect(t?.identity).toBe("old");
});

// A store that does not answer is not a scope the legacy writer owns: nothing is settled.
const unanswered = () => {
  const outcomes: string[] = [];
  const fail = async (): Promise<never> => {
    throw new Error("store busy");
  };
  const deck: DeckAnalysis = {
    deckObjects: fail,
    excludedObjectIds: fail,
    currentDeck: fail,
    heldTensions: fail,
    assembleDeck: fail,
    owns: fail,
  };
  const logger = { warn() {}, error() {}, info() {}, debug() {} } as unknown as Logger;
  const publisher = new Publisher(
    { executor: {} as ExecutorDeps, deck, logger },
    "project",
    outcomes,
  );
  return { publisher, outcomes };
};

test("a conversation stays owed when the store cannot say who writes it", async () => {
  const { publisher, outcomes } = unanswered();
  const state: Json = { conversations: { c1: { done: true, revision: 3, items: [] } } };
  await publisher.conversation(state, { id: "c1", text: "words" });
  expect(((state.conversations as Json).c1 as Json).published_revision).toBeUndefined();
  expect(outcomes.length).toBe(1);
});

test("tensions are not settled when the store cannot say who writes them", async () => {
  const { publisher } = unanswered();
  const book = new QuoteBook(new Map());
  await expect(publisher.tensions({ tensions: [] }, [], book)).rejects.toThrow();
  expect(publisher.tensionsSettled).toBe(false);
});

test("a read whose tensions fail to publish keeps its slide, owed to the next read", async () => {
  const { publisher } = unanswered();
  const outcomes: string[] = [];
  const slide = { tensions: [{ id: "x1", identity: "i1", poleA: "a", poleB: "b", quoteIds: [] }] };
  const kept = await publishTensions(publisher, slide, [], new QuoteBook(new Map()), outcomes);
  expect(kept).toBeNull();
  expect(outcomes).toEqual(["tensions: publishing FAILED store busy"]);
  const state: Json = {
    analysis: {
      tensions: slide,
      fingerprints: { tensions: "fp-new" },
      published: { tensions: "fp-old" },
    },
  };
  expect(unpublishedTensions(state)).toBe(true);
});
