import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import {
  advanceMapView,
  analysisRuntime,
  clientOf,
  execute,
  type Json,
  MapViewReads,
} from "@echo/analysis";
import { createDb } from "@echo/db";
import { FakeCompleter, FakeEmbedder } from "@echo/llm";
import { createLogger } from "@echo/observability";
import postgres from "postgres";
import { runFactCheck } from "../src/factcheck";
import * as service from "../src/service";
import { MapStore } from "../src/store";

/**
 * Map against a copy of the parity seed: a generation through the arguments recipe, a
 * fact-check of a snapshot's claim recorded as an assessment that advances the view, and
 * a selection title, all on a fake model with the answers the Python stack produced.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = "parity_template_platform";
const DB = `map_it_${process.pid}`;
const hasTemplate = admin
  ? await (async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
      await sql.end();
      return Boolean(row);
    })().catch(() => false)
  : false;
const run = hasTemplate ? describe : describe.skip;
const P1 = "f0000000-0000-4000-8000-000000000001";
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const ANSWERS: Record<string, Json> = {
  "charging points": {
    items: [
      {
        kind: "claim",
        statement: "The waiting list for charging points near the flats is months long.",
        evidence: ["the waiting list is months long"],
        valence: "negative",
      },
    ],
  },
  "cycle lanes": {
    items: [
      {
        kind: "argument",
        statement: "Cycle lanes should continue past the ring road.",
        evidence: ["the cycle lanes end abruptly at the ring road"],
        valence: "negative",
      },
    ],
  },
};

run("map on the seed", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  const completer = new FakeCompleter((g) => `vertex_ai/fake-${g}`);
  // The fact-check prompts quote the claim, so they are matched before the extraction answers.
  completer.on("CLAIM START", async (r) =>
    r.googleSearch
      ? {
          text: "Waiting lists are about three weeks.",
          sources: [{ url: "https://example.org/a", title: "A" }],
        }
      : JSON.stringify({
          verdict: "false",
          justification: "Waiting  lists are weeks, not months.",
        }),
  );
  completer.on("Arguments in cluster", '  "Charging and cycling gaps"  \nsecond line');
  for (const [needle, answer] of Object.entries(ANSWERS))
    completer.on(needle, JSON.stringify(answer));

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    database = createDb({
      url: `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`,
      poolMax: 4,
    });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  test("generate, fact-check a claim, record it and advance the view; title a selection", async () => {
    const enqueued: string[] = [];
    const rt = analysisRuntime({
      db: database.db,
      logger: quiet,
      completer,
      embedder: new FakeEmbedder(8),
      jobs: {
        enqueue: async (def) => {
          enqueued.push(def.name);
          return crypto.randomUUID();
        },
      },
      config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
    });
    const store = new MapStore(clientOf(database.db));

    // Generation is a refresh of the arguments recipe; the worker side executes it.
    const attempt = await service.requestGeneration({ store, rt }, P1, "tester");
    expect(attempt?.status).toBe("queued");
    expect(await execute(rt.executor, String(attempt?.id), "lease-1")).toBe("ready");
    const snapshot = await advanceMapView(P1, rt.store, new MapViewReads(rt.store), {
      publish: rt.publishMap,
    });
    expect(snapshot).not.toBeNull();
    const revisions = await rt.store.getRevisions(
      P1,
      ((snapshot?.manifest.objects as Json[]) ?? []).map((o) => String(o.revisionId)),
    );
    const claimRevision = [...revisions.values()].find((r) => r.payload.epistemicKind === "claim");
    expect(claimRevision).toBeDefined();

    const target: service.SnapshotTarget = {
      kind: "snapshot",
      snapshot: snapshot as NonNullable<typeof snapshot>,
      resultId: null,
    };
    const dispatched: Json[] = [];
    const started = await service.startFactCheck(
      { store, rt, dispatch: async (job) => dispatched.push(job) },
      target,
      String(claimRevision?.id),
      "tester",
      false,
    );
    expect(started.status).toBe("processing");
    expect(dispatched).toHaveLength(1);

    const job = dispatched[0] as {
      factCheckId: string;
      attempt: number;
      resultId: string;
      nodeId: string;
    };
    expect(await runFactCheck({ store, rt, completer }, job)).toBe("done");
    const row = await store.getFactCheck(job.factCheckId);
    expect(row?.status).toBe("done");
    expect(row?.verdict).toBe("false");
    expect(row?.justification).toBe("Waiting lists are weeks, not months.");
    expect(row?.sources).toEqual([{ url: "https://example.org/a", title: "A" }]);

    // The verdict became an assessment revision, and the view advanced to pin it.
    const reads = new MapViewReads(rt.store);
    const scope = await rt.store.findScope({
      projectId: P1,
      kind: "view",
      ownerId: "map",
      scopeKey: "project",
    });
    const current = await rt.store.getSnapshot(String(scope?.currentSnapshotId));
    expect(current?.id).not.toBe(snapshot?.id);
    expect(
      ((current?.manifest.assessments ?? []) as Json[]).map((a) => a.targetRevisionId),
    ).toEqual([claimRevision?.id]);
    const states = await service.snapshotFactCheckStates(
      { store, rt },
      { kind: "snapshot", snapshot: current as NonNullable<typeof current>, resultId: null },
    );
    expect((states[String(claimRevision?.id)] as Json).verdict).toBe("false");

    // A repeat of the same attempt changes nothing.
    expect(await runFactCheck({ store, rt, completer }, job)).toBe("stale");

    // A title of two objects is refused; the model is never asked.
    const titleDeps = {
      store,
      rt,
      cache: new service.TitleCache(),
      modelIdentity: "vertex_ai/fake",
      generate: async () => "unused",
    };
    const ids = ((current?.manifest.objects as Json[]) ?? []).map((o) => String(o.revisionId));
    await expect(
      service.snapshotSelectionTitle(
        titleDeps,
        { kind: "snapshot", snapshot: current as NonNullable<typeof current>, resultId: null },
        ids,
        ["City", ""],
      ),
    ).rejects.toThrow("a title needs at least 3 objects");
    // Three objects are needed; with two the refusal comes before any model call.
    expect(
      completer.calls.filter((c) => String(c.user).includes("Arguments in cluster")),
    ).toHaveLength(0);
    expect(reads).toBeDefined();
  });
});
