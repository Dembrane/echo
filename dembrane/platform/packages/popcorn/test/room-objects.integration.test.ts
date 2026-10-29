import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type AnalysisRuntime,
  type ExecutorDeps,
  PRODUCERS_KEY,
  type ProducerServices,
  readSnapshot,
} from "@dembrane/analysis";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { type BffDeps, listAnalysisObjects } from "../../analysis/src/bff";
import { RevisionService } from "../../analysis/src/revisions";
import { appClient, executorDeps, quiet } from "../../analysis/test/harness";
import { analysisDeck, applyPublishedObjects, curatePresentation, deckQuoteId } from "../src/deck";
import type { Json } from "../src/py";
import { Publisher } from "../src/tick/publish";
import { unpublishedConversations, unpublishedTensions } from "../src/tick/run";
import { QuoteBook } from "../src/tick/shapes";
import { fixture, freshDatabase, ids, seed } from "./fixtures/tick/seed";

// The live session's tensions published through the analysis executor, against Postgres:
// the room's slide, the deck view's snapshot (which the host's results list) and the
// objects are one set, and a tension keeps its object across reads.
// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const P = ids.project;

run("the room and the host's results read the same objects", () => {
  setDefaultTimeout(60_000);
  let raw: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  let transcripts: Json[] = [];

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_room_objects_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
    ({ sql, close } = appClient(url));
    deps = executorDeps(sql, { completer: new FakeCompleter() });
    const producers = deps.services[PRODUCERS_KEY] as ProducerServices;
    transcripts = (await producers.transcripts(P)).map((t) => ({ id: t.id, text: t.text }));
  });
  afterAll(async () => {
    await close();
    await raw?.end();
    await database?.close();
  });

  const deck = () => analysisDeck(deps.store);
  const publisher = (outcomes: string[]) =>
    new Publisher({ executor: deps, deck: deck(), logger: quiet }, P, outcomes);
  /** A verbatim stretch of a conversation, as the tick's quotes are. */
  const said = (i: number, from: number, length = 40) => {
    const t = transcripts[i] as Json;
    return {
      transcript: String(t.id),
      text: String(t.text)
        .slice(from, from + length)
        .trim(),
    };
  };
  /** A tick-shaped tensions slide: what tick/tensions.ts returns, quotes in the session's book. */
  const slide = (book: QuoteBook, tensions: [string, string, number][]) => ({
    tensions: tensions.map(([identity, poleA, from], i) => {
      const a = book.add(said(0, from)) as string;
      const b = book.add(said(1, from)) as string;
      return {
        id: `x${i + 1}`,
        identity,
        poleA,
        poleB: `not ${poleA}`,
        knot: "The pull is real.",
        toResolve: "Which comes first?",
        quoteIds: [a, b],
        quotePoles: { [a]: "A", [b]: "B" },
      };
    }),
  });
  const deckSnapshot = async () => {
    const current = await deck().currentDeck(P);
    if (!current) throw new Error("no deck snapshot");
    return current;
  };

  test("the tensions slide is the published objects, named by their object ids", async () => {
    expect(fixture.seed.conversation?.length).toBe(2);
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const outcomes: string[] = [];
    const published = await publisher(outcomes).tensions(
      slide(book, [
        ["pair-one", "Parking first", 0],
        ["pair-two", "Trees first", 50],
      ]),
      transcripts,
      book,
    );
    expect(outcomes).toEqual([]);
    const items = (published?.tensions as Json[]) ?? [];
    expect(items.map((t) => t.identity).sort()).toEqual(["pair-one", "pair-two"]);
    for (const t of items) {
      expect(t.id).toBe(t.objectId);
      // The session's book holds every quote the slide cites.
      const held = new Set(book.quotes.map((q) => String(q.id)));
      for (const q of t.quoteIds as string[]) expect(held.has(q)).toBe(true);
    }

    const objects = await deck().deckObjects(P);
    expect(objects.ownsTensions).toBe(true);
    expect(objects.tensions.map((r) => r.recipeId)).toEqual([
      "popcorn.tensions",
      "popcorn.tensions",
    ]);
    // What the host's results list, given the deck's snapshot, is what the room shows.
    const snapshot = await deckSnapshot();
    const listed = ((snapshot.manifest.objects as Json[]) ?? [])
      .filter((o) => o.type === "tension")
      .map((o) => String(o.objectId))
      .sort();
    expect(listed).toEqual(items.map((t) => String(t.objectId)).sort());
    const full = await deps.store.getSnapshot(snapshot.id);
    if (!full) throw new Error("the deck snapshot is gone");
    const contents = await readSnapshot(full, deps.store);
    for (const r of contents.revisions.values())
      if (r.type === "tension")
        for (const ref of r.provenance.sourceRefs ?? [])
          expect(transcripts.map((t) => t.id)).toContain(ref.conversationId);
  });

  test("a tension found again keeps its object; one no longer found leaves the room", async () => {
    const before = await deck().deckObjects(P);
    const one = before.tensions.find((r) => r.extra.identity === "pair-one");
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    await publisher([]).tensions(
      slide(book, [["pair-one", "Parking before anything else", 0]]),
      transcripts,
      book,
    );
    const after = await deck().deckObjects(P);
    expect(after.tensions.length).toBe(1);
    const [again] = after.tensions;
    expect(again?.objectId).toBe(one?.objectId as string);
    expect(again?.id).not.toBe(one?.id as string);
    expect(again?.payload.poleA).toBe("Parking before anything else");
  });

  test("the deck the room reads cites only published tensions, by derived quote ids", async () => {
    const objects = await deck().deckObjects(P);
    const session = {
      files: {
        "session.json": { transcripts: [] },
        "quotes.json": { quotes: [{ id: "q1", transcript: "c", text: "words" }] },
        "tensions.json": { tensions: [{ id: "x9", poleA: "session only", quoteIds: ["q1"] }] },
      },
    };
    const files = applyPublishedObjects(session, objects, {
      settings: { tabs: { tensions: true } },
      project: {},
      host: false,
    }).files as Json;
    const tensions = (files["tensions.json"] as Json).tensions as Json[];
    expect(tensions.map((t) => t.objectId)).toEqual(objects.tensions.map((r) => r.objectId));
    const registry = new Map(
      ((files["quotes.json"] as Json).quotes as Json[]).map((q) => [String(q.id), q]),
    );
    for (const t of tensions)
      for (const id of t.quoteIds as string[]) {
        const q = registry.get(id) as Json;
        expect(id).toBe(deckQuoteId(String(q.transcript), String(q.text)));
      }
  });

  test("a slide written before tensions kept identities is published as it stands", async () => {
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const legacy = slide(book, [["", "Buses at night", 80]]);
    for (const t of legacy.tensions) {
      delete (t as Json).identity;
      delete (t as Json).quotePoles;
    }
    const state: Json = {
      analysis: { tensions: legacy, fingerprints: { tensions: "fp-1" } },
    };
    expect(unpublishedTensions(state)).toBe(true);
    const p = publisher([]);
    const first = await p.tensions(legacy, transcripts, book);
    expect(p.tensionsSettled).toBe(true);
    const [published] = (first?.tensions as Json[]) ?? [];
    expect(String(published?.identity)).toMatch(/^slide-[0-9a-f]{24}$/);
    // The same slide read again is the same object.
    const again = await publisher([]).tensions(legacy, transcripts, book);
    expect(((again?.tensions as Json[]) ?? [])[0]?.objectId).toBe(published?.objectId as string);
    state.analysis = { ...(state.analysis as Json), published: { tensions: "fp-1" } };
    expect(unpublishedTensions(state)).toBe(false);
  });

  /**
   * Publish a tension, then read it again as the next read words it: the positions come back
   * reworded (so the tick derives another identity) on the same passages, one said at more length.
   */
  const readAgain = async (identity: string, from: number, between = async (_t: Json) => {}) => {
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const first = await publisher([]).tensions(
      slide(book, [[identity, "Lanes first", from]]),
      transcripts,
      book,
    );
    const [shown] = (first?.tensions as Json[]) ?? [];
    await between(shown as Json);
    // The outbox advances the deck view after a host's change, as it does live.
    await deck().assembleDeck(P);
    const again = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const a = again.add(said(0, from)) as string;
    const b = again.add(said(1, from, 70)) as string;
    const reread = await publisher([]).tensions(
      {
        tensions: [
          {
            id: "x1",
            identity: `${identity}-reworded`,
            poleA: "Lanes come first",
            poleB: "not Lanes first",
            knot: "Said again.",
            toResolve: "Which comes first?",
            quoteIds: [a, b],
            quotePoles: { [a]: "A", [b]: "B" },
          },
        ],
      },
      transcripts,
      again,
    );
    return { shown: shown as Json, reread: ((reread?.tensions as Json[]) ?? []) as Json[] };
  };

  test("a tension read again in other words keeps its object, so the host's hide holds", async () => {
    const { shown, reread } = await readAgain("read-one", 30);
    expect(reread.map((t) => t.objectId)).toEqual([shown.objectId]);
    expect(reread[0]?.poleA).toBe("Lanes come first");
    // Present hides by object id (the draft's hidden_items): the room drops it again.
    const room = applyPublishedObjects(
      { files: { "session.json": { transcripts: [] } } },
      await deck().deckObjects(P),
      { settings: { tabs: { tensions: true } }, project: {}, host: false },
    );
    const curated = curatePresentation(room, {
      presentation: { hidden_items: [String(shown.objectId)] },
    });
    expect(((curated.files as Json)["tensions.json"] as Json).tensions).toEqual([]);
  });

  test("a tension the host edited keeps its object when it is read again in other words", async () => {
    const { shown, reread } = await readAgain("read-edited", 90, async (t) => {
      const [held] = (await deck().deckObjects(P)).tensions.filter(
        (r) => r.objectId === t.objectId,
      );
      await new RevisionService(deps.store).authorEdit({
        projectId: P,
        objectId: String(t.objectId),
        expected: String(t.revisionId),
        payload: { ...(held?.payload as Json), knot: "The host's words." },
        actorId: ids.user,
      });
    });
    expect(reread.map((t) => t.objectId)).toEqual([shown.objectId]);
  });

  test("a tension the host withdrew stays withdrawn when it is read again in other words", async () => {
    const { shown } = await readAgain("read-withdrawn", 60, async (t) => {
      await new RevisionService(deps.store).setExcluded({
        projectId: P,
        objectId: String(t.objectId),
        expected: String(t.revisionId),
        excluded: true,
        actorId: ids.user,
      });
    });
    // Neither the withdrawn object nor a new one in the read's words is in the room.
    const shownNow = (await deck().deckObjects(P)).tensions.filter(
      (r) => r.objectId === shown.objectId || r.payload.poleA === "Lanes come first",
    );
    expect(shownNow).toEqual([]);
    expect((await deck().excludedObjectIds(P)).has(String(shown.objectId))).toBe(true);
  });

  test("the results table lists the pinned slide's tensions as the host last left them", async () => {
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const published = await publisher([]).tensions(
      slide(book, [
        ["pinned-one", "Parking first", 0],
        ["pinned-two", "Trees first", 50],
      ]),
      transcripts,
      book,
    );
    const [edited, withdrawn] = (published?.tensions as Json[]) ?? [];
    // The room is pinned to this snapshot ("Show them"); the host then works the table.
    const pinned = (await deckSnapshot()).id;
    const revisions = new RevisionService(deps.store);
    const edit = await revisions.authorEdit({
      projectId: P,
      objectId: String(edited?.objectId),
      expected: String(edited?.revisionId),
      payload: {
        ...((await deck().deckObjects(P)).tensions.find((r) => r.objectId === edited?.objectId)
          ?.payload as Json),
        knot: "Edited by the host.",
      },
      actorId: ids.user,
    });
    await revisions.setExcluded({
      projectId: P,
      objectId: String(withdrawn?.objectId),
      expected: String(withdrawn?.revisionId),
      excluded: true,
      actorId: ids.user,
    });
    const bff: BffDeps = {
      db: database.db,
      rt: { store: deps.store } as AnalysisRuntime,
      access: { project: async () => ({ project: { id: P }, tier: "changemaker" }) } as never,
      limiter: { check: async () => {} } as never,
      enablePresent: true,
      now: () => new Date(),
    };
    const listed = await listAnalysisObjects(
      bff,
      { appUserId: ids.appUser, directusUserId: ids.user } as Signed,
      P,
      {
        type: "tension",
        scope: null,
        snapshot_id: pinned,
        latest: true,
        membership: "active",
        sort: "attention",
        offset: 0,
        limit: 50,
      },
    );
    // The row is the revision the next edit must name, and a withdrawn tension leaves.
    expect(listed.items.map((i) => [i.objectId, i.revisionId])).toEqual([[edit.objectId, edit.id]]);
  });

  test("a conversation is owed a publication until its revision reaches the store", async () => {
    const [t] = transcripts;
    const cid = String(t?.id);
    const state: Json = {
      conversations: {
        [cid]: { done: true, revision: 3, fingerprint: "f", items: [], label: "One" },
      },
      quotes: [],
    };
    const transcript = { ...t, fingerprint: "f" };
    expect(unpublishedConversations(state, [transcript]).length).toBe(1);
    await publisher([]).conversation(state, transcript);
    expect(((state.conversations as Json)[cid] as Json).published_revision).toBe(3);
    expect(unpublishedConversations(state, [transcript]).length).toBe(0);
  });
});
