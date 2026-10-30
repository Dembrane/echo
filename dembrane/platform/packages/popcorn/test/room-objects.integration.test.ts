import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type AnalysisRuntime,
  type ExecutorDeps,
  PRODUCERS_KEY,
  type ProducerServices,
  readSnapshot,
} from "@dembrane/analysis";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { type BffDeps, listAnalysisObjects, requestAnalysisRun } from "../../analysis/src/bff";
import { RevisionService } from "../../analysis/src/revisions";
import { appClient, executorDeps, quiet } from "../../analysis/test/harness";
import {
  analysisDeck,
  applyPublishedObjects,
  applyResultBindings,
  curatePresentation,
  deckQuoteId,
  withoutObjects,
} from "../src/deck";
import type { Json } from "../src/py";
import { normalizeState, owesPublication } from "../src/state";
import { Publisher } from "../src/tick/publish";
import { runPopcornTick, unpublishedConversations, unpublishedTensions } from "../src/tick/run";
import { QuoteBook } from "../src/tick/shapes";
import { tickDeps } from "../src/worker";
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

  /** Publish a tension, then read it again reworded on the same passages, one quote longer. */
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

  test("the results table and the room show a pinned slide as the host last left it", async () => {
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
    // The room, built as the server builds it: the pin, then what the host withdrew.
    const room = withoutObjects(
      await applyResultBindings(
        { files: {} },
        {
          settings: {
            tabs: { tensions: true },
            presentation: { result_bindings: { tensions: `analysis:${pinned}` } },
          },
          projectId: P,
          deck: deck(),
        },
      ),
      await deck().excludedObjectIds(P),
    );
    const shown = ((room.files as Json)["tensions.json"] as Json).tensions as Json[];
    expect(shown.map((t) => [t.objectId, t.revisionId, t.knot])).toEqual([
      [edit.objectId, edit.id, "Edited by the host."],
    ]);
  });

  test("a pinned stakeholder the host edited keeps its relations in the room", async () => {
    const said = (i: number, text: string) => ({ transcript: String(transcripts[i]?.id), text });
    const answer = {
      stakeholders: [
        {
          name: "Residents",
          role: "People in the flats",
          stake: "Charging near home",
          rung: "voiced",
          stakeWeight: 0.9,
          mentionsWeight: 1,
          quotes: [said(0, "the waiting list is months long")],
        },
        {
          name: "Council",
          role: "Answers letters",
          stake: "The grid",
          rung: "named",
          stakeWeight: 0.5,
          mentionsWeight: 0.5,
          quotes: [said(1, "The council never answers our letters about the grid")],
        },
      ],
      relations: [
        {
          between: ["Residents", "Council"],
          label: "wait for answers",
          intensity: 0.6,
          sentiment: -0.4,
          unowned: false,
          detail: "Residents write; the council does not answer.",
          aspects: [],
        },
      ],
    };
    const fake = new FakeCompleter();
    fake.on(
      () => true,
      () => JSON.stringify(answer),
    );
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const pinnedSlide = await new Publisher(
      { executor: executorDeps(sql, { completer: fake }), deck: deck(), logger: quiet },
      P,
      [],
    ).stakeholders(
      transcripts.map((t) => ({ ...t, label: "", created_at: null })),
      book,
    );
    expect(((pinnedSlide?.relations as Json[]) ?? []).length).toBe(1);
    const pinned = (await deckSnapshot()).id;
    const residents = (await deck().deckObjects(P)).stakeholders.find(
      (r) => r.payload.name === "Residents",
    );
    await new RevisionService(deps.store).authorEdit({
      projectId: P,
      objectId: String(residents?.objectId),
      expected: String(residents?.id),
      payload: { ...(residents?.payload as Json), role: "Edited by the host." },
      actorId: ids.user,
    });
    const room = await applyResultBindings(
      { files: {} },
      {
        settings: {
          tabs: { stakeholders: true },
          presentation: { result_bindings: { stakeholders: `analysis:${pinned}` } },
        },
        projectId: P,
        deck: deck(),
      },
    );
    const shown = (room.files as Json)["stakeholders.json"] as Json;
    expect((shown.stakeholders as Json[]).map((x) => x.role)).toContain("Edited by the host.");
    expect((shown.relations as Json[]).map((r) => r.label)).toEqual(["wait for answers"]);
  });

  test("a live tensions run is the tick's alone: the analysis route refuses to start one", async () => {
    // Outside a tick the recipe would read the session without the identities the tick carries.
    const bff: BffDeps = {
      db: database.db,
      rt: { store: deps.store } as AnalysisRuntime,
      access: { project: async () => ({ project: { id: P }, tier: "changemaker" }) } as never,
      limiter: { check: async () => {} } as never,
      enablePresent: true,
      now: () => new Date(),
    };
    await expect(
      requestAnalysisRun(bff, { appUserId: ids.appUser, directusUserId: ids.user } as Signed, P, {
        recipe_id: "popcorn.tensions",
        scope_key: "project",
        parameters: {},
        selected_revision_ids: [],
        mode: "full",
        idempotency_key: null,
        refresh_dependencies: false,
        retry_run_id: null,
      }),
    ).rejects.toMatchObject({ code: "analysis.recipe_internal" });
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

  test("a publishing read that can publish nothing owed stops the deck asking again", async () => {
    const [t] = transcripts;
    // Owed but unpublishable: a deleted conversation, and one whose transcript changed after
    // it was read (late audio). Neither is published by a read that reads nothing new.
    const state = {
      version: 1,
      run: 4,
      order: [String(t?.id)],
      conversations: {
        "c9000000-0000-4000-8000-000000000009": { done: true, revision: 1, items: [] },
        [String(t?.id)]: { done: true, revision: 2, fingerprint: "before-late-audio", items: [] },
      },
      quotes: [],
      analysis: {},
    };
    await raw`update agent_loop set status = 'paused', popcorn_state = ${raw.json(state as never)}
      where id = ${ids.loop}`;
    expect(owesPublication(state)).toBe(true);
    const completer = new FakeCompleter();
    const read = await runPopcornTick(
      {
        ...tickDeps(
          {
            db: database.db,
            logger: quiet,
            completer,
            flags: { present: true, canvas: true },
            participantBaseUrl: "http://localhost:5174",
            adminBaseUrl: "http://localhost:5173",
            databaseUrl: "unused",
            analysis: () => ({ deck: deck(), executor: deps }),
          },
          "publish-nothing-owed",
          { deck: deck(), executor: deps },
        ),
        heartbeatMs: 50,
      },
      ids.loop,
      "publish",
      newId(),
    );
    expect(read.status).toBe("no_op");
    expect(completer.calls.length).toBe(0);
    const [loop] = await raw`select popcorn_state from agent_loop where id = ${ids.loop}`;
    // As the deck reads it: normalised.
    expect(owesPublication(normalizeState(loop?.popcorn_state))).toBe(false);
  });

  test("a session whose live reads ended publishes its held tensions when a host asks, without the model", async () => {
    // A finished session as deploy found it: a tensions slide in its state, never published.
    const book = new QuoteBook(new Map(transcripts.map((t) => [String(t.id), String(t.text)])));
    const held = slide(book, [["", "Bins before benches", 120]]);
    for (const t of held.tensions) delete (t as Json).identity;
    const state = {
      version: 1,
      run: 3,
      order: [],
      conversations: {},
      quotes: book.quotes,
      analysis: { tensions: held, fingerprints: { tensions: "fp-held" }, updated: {} },
    };
    await raw`update agent_loop set status = 'paused', popcorn_state = ${raw.json(state as never)}
      where id = ${ids.loop}`;
    const completer = new FakeCompleter();
    const publishingRead = (workflow: string) =>
      runPopcornTick(
        {
          ...tickDeps(
            {
              db: database.db,
              logger: quiet,
              completer,
              flags: { present: true, canvas: true },
              participantBaseUrl: "http://localhost:5174",
              adminBaseUrl: "http://localhost:5173",
              databaseUrl: "unused",
              analysis: () => ({ deck: deck(), executor: deps }),
            },
            workflow,
            { deck: deck(), executor: deps },
          ),
          heartbeatMs: 50,
        },
        ids.loop,
        "publish",
        newId(),
      );
    const tick = await publishingRead("publish-test");
    expect(tick.status).toBe("ok");
    // No model is asked, translation included.
    expect(completer.calls.length).toBe(0);
    const [loop] = await raw`select popcorn_state, status from agent_loop where id = ${ids.loop}`;
    const after = (loop?.popcorn_state ?? {}) as Json;
    expect(unpublishedTensions(after)).toBe(false);
    // Nothing new is read: the session lists no conversation it was not already reading.
    expect(Object.keys((after.conversations as Json) ?? {})).toEqual([]);
    expect(loop?.status).toBe("paused");
    const objects = await deck().deckObjects(P);
    expect(objects.tensions.map((r) => r.payload.poleA)).toContain("Bins before benches");
    // A second publishing read finds nothing owed.
    expect((await publishingRead("publish-test-2")).status).toBe("no_op");
    expect(completer.calls.length).toBe(0);
  });
});
