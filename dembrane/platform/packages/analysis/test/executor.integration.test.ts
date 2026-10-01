import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type postgres from "postgres";
import { resolveBudgets } from "../src/budgets";
import { type Json, RevisionConflict } from "../src/contracts";
import { cancelRun, type ExecutorDeps, execute, requestRun } from "../src/executor";
import { advanceMapView, graphPayload, MapViewReads } from "../src/mapview";
import { RevisionService } from "../src/revisions";
import {
  appClient,
  dropDatabase,
  executorDeps,
  extractionFake,
  freshDatabase,
  hasTemplate,
  P1,
  P1_ANSWERS,
} from "./harness";

const DB = `analysis_it_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;

run("the executor against the seed", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  const fake = extractionFake(P1_ANSWERS);
  const events: Json[] = [];

  beforeAll(async () => {
    ({ sql, close } = appClient(await freshDatabase(DB)));
    deps = executorDeps(sql, { completer: fake, events });
  });
  afterAll(async () => {
    await close();
    await dropDatabase(DB);
  });

  let firstRunId = "";

  test("an arguments run extracts, grounds, embeds and publishes", async () => {
    const outcome = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project", requestedBy: "tester" },
      deps,
    );
    expect(outcome.outcome).toBe("created");
    expect(outcome.run.status).toBe("queued");
    const sources = ((outcome.run.inputManifest?.sources ?? []) as Json[]).map(
      (s) => s.conversationId,
    );
    expect(sources.length).toBe(2);
    firstRunId = outcome.run.id;

    expect(await execute(deps, outcome.run.id, "lease-one")).toBe("ready");
    const ready = await deps.store.getRun(outcome.run.id);
    expect(ready?.status).toBe("ready");
    const objects = (ready?.outputManifest?.objects as Json[]) ?? [];
    // Two items from the first conversation (one dropped as ungrounded), one from the second.
    expect(objects.length).toBe(3);
    expect(fake.calls.length).toBe(2);
    const steps = await deps.store.getSteps(outcome.run.id);
    expect(steps.map((s) => s.stepKey.split(":")[0]).sort()).toEqual(
      ["embed", "extract", "extract", "ground", "load", "merge"].sort(),
    );
    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(events.some((e) => e.type === "ready")).toBe(true);
  });

  test("a refresh over unchanged inputs reuses the ready output without a model call", async () => {
    const before = fake.calls.length;
    const outcome = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project" },
      deps,
    );
    expect(outcome.outcome).toBe("reused");
    expect(outcome.run.status).toBe("ready");
    expect(outcome.run.reusedRunId).toBe(firstRunId);
    expect(fake.calls.length).toBe(before);
  });

  test("a regenerate calls the model again but keeps unchanged revisions", async () => {
    const before = fake.calls.length;
    const first = await deps.store.getRun(firstRunId);
    const outcome = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project", mode: "regenerate" },
      deps,
    );
    expect(outcome.outcome).toBe("created");
    expect(await execute(deps, outcome.run.id, "lease-two")).toBe("ready");
    expect(fake.calls.length).toBe(before + 2);
    const second = await deps.store.getRun(outcome.run.id);
    const ids = (m: Json | null | undefined) =>
      ((m?.objects as Json[]) ?? []).map((o) => o.revisionId).sort();
    expect(ids(second?.outputManifest)).toEqual(ids(first?.outputManifest));
  });

  test("the map view pins the output and serves it as a graph", async () => {
    const reads = new MapViewReads(deps.store);
    const published: Json[] = [];
    const snapshot = await advanceMapView(P1, deps.store, reads, {
      publish: async (_p, e) => {
        published.push(e);
      },
    });
    expect(snapshot).not.toBeNull();
    expect(((snapshot?.manifest.objects as Json[]) ?? []).length).toBe(3);
    expect(published[0]?.type).toBe("ready");
    const payload = await graphPayload(
      snapshot as NonNullable<typeof snapshot>,
      {
        types: null,
        scope: null,
        budgets: resolveBudgets(null, null, { nodeLimit: null, edgeLimit: null }),
      },
      deps.store,
    );
    expect((payload.nodes as Json[]).length).toBe(3);
    expect((payload.nodes as Json[]).every((n) => Array.isArray(n.embedding))).toBe(true);
    // Identical content keeps the current snapshot.
    const again = await advanceMapView(P1, deps.store, reads, { publish: async () => {} });
    expect(again?.id).toBe(snapshot?.id);
  });

  test("an authored edit names its head; a stale one is a conflict carrying the head", async () => {
    const ready = await deps.store.getRun(firstRunId);
    const entry = ((ready?.outputManifest?.objects as Json[]) ?? [])[0] as Json;
    const service = new RevisionService(deps.store);
    const head = (await deps.store.getRevisions(P1, [String(entry.revisionId)])).get(
      String(entry.revisionId),
    );
    const edited = await service.authorEdit({
      projectId: P1,
      objectId: String(entry.objectId),
      expected: String(entry.revisionId),
      payload: { ...head?.payload, statement: "A reworded statement." },
      actorId: "host-1",
      reason: "clearer words for the room",
      changeKind: "clarity",
    });
    expect(edited.provenance.origin).toBe("authored");
    expect(edited.status).toBe("published");
    await expect(
      service.authorEdit({
        projectId: P1,
        objectId: String(entry.objectId),
        expected: String(entry.revisionId),
        payload: { ...head?.payload, statement: "Another wording." },
        actorId: "host-2",
      }),
    ).rejects.toBeInstanceOf(RevisionConflict);
    const outbox =
      await sql`select event_type, payload from analysis_outbox where event_type = 'revision_published'`;
    expect(outbox.length).toBe(1);
  });

  test("the integration fixture turns selected revisions into a delivery payload", async () => {
    const heads = await deps.store.currentRevisions(P1);
    const selected = [...heads.values()].filter((r) => r.type === "argument").map((r) => r.id);
    const outcome = await requestRun(
      {
        projectId: P1,
        recipeId: "integration.fixture_delivery",
        scopeKey: "delivery:acme",
        selectedRevisionIds: selected,
      },
      deps,
    );
    expect(await execute(deps, outcome.run.id, "lease-three")).toBe("ready");
    const done = await deps.store.getRun(outcome.run.id);
    const [payload] = (done?.outputManifest?.objects as Json[]) ?? [];
    const revision = (await deps.store.getRevisions(P1, [String(payload?.revisionId)])).get(
      String(payload?.revisionId),
    );
    expect(((revision?.payload.body ?? {}) as Json).items).toHaveLength(selected.length);
  });

  test("a cancelled run cannot publish", async () => {
    const outcome = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project", mode: "regenerate" },
      deps,
    );
    const cancelled = await cancelRun(outcome.run.id, deps);
    expect(cancelled?.status).toBe("cancelled");
    expect(await execute(deps, outcome.run.id, "lease-four")).toBe("cancelled");
  });
});
