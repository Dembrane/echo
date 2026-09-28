import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@echo/access";
import { createDb, migrate } from "@echo/db";
import { FakeCompleter } from "@echo/llm";
import { installQueueSchema } from "@echo/queue";
import { MemoryRateCounter, RateLimiter } from "@echo/ratelimit";
import { Hono } from "hono";
import postgres from "postgres";
import { canvasEventStream, publishGenerationNudge } from "../src/events";
import { previewCanvas } from "../src/service";
import { canvasStore, client } from "../src/storage";
import { derivedId, reconcileMissingTicks, runTick, type TickDeps } from "../src/ticks";
import { EXTRACTION, freshDatabase, GUIDE, ids, seed } from "./fixtures/seed";

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

function fake() {
  return new FakeCompleter()
    .on("You update a dembrane tabbed living canvas", EXTRACTION)
    .on("Open questions tab", GUIDE);
}

run("canvas tick against Postgres", () => {
  setDefaultTimeout(60_000);
  let url = "";
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;

  function deps(completer: FakeCompleter, seedLabel: string): TickDeps {
    const sql = client(database.db);
    return {
      store: canvasStore(sql),
      accessStore: new DrizzleAccessStore(database.db),
      completer,
      canvasEnabled: true,
      now: () => new Date(),
      nudge: async () => {},
      claimWindow: async () => true,
      idFor: (label) => derivedId(`${seedLabel}:${label}`),
    };
  }

  beforeAll(async () => {
    url = await freshDatabase(admin as string, "canvas_tick_test");
    await migrate(url);
    database = createDb({ url, poolMax: 4 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  test("a manual tick merges receipts, renders the wall and schedules the next tick", async () => {
    const completer = fake();
    expect(await runTick(deps(completer, "t1"), ids.loop, "manual")).toBe("ok");
    const [gen] =
      await raw`select * from canvas_generation where report_id = ${ids.report} and status = 'ok'`;
    expect(gen?.tick_kind).toBe("manual");
    expect(String(gen?.content_html)).toContain("Where should the next chargers go?");
    expect(String(gen?.content_html)).toContain("We need more charging points near the flats.");
    expect(String(gen?.detail)).toContain("backfill: 1 conversations");
    const [loop] = await raw`select * from agent_loop where id = ${ids.loop}`;
    expect(loop?.canvas_quotes_ledger).toHaveLength(1);
    expect(loop?.canvas_host_guide).toMatchObject({
      where_the_room_is: "The room wants chargers.",
    });
    const [task] = await raw`select * from scheduled_task where task_type = 'canvas_tick'`;
    expect(task?.payload).toEqual({ loop_id: ids.loop, tick_kind: "scheduled" });
    const runs = await raw`select status from agent_loop_run where loop_id = ${ids.loop}`;
    expect(runs.map((r) => r.status)).toEqual(["ok"]);
    // The model read the transcript once (a cold start backfills) and wrote the guide once.
    expect(completer.calls.length).toBe(2);
  });

  test("a scheduled tick with nothing new records a no-op and calls no model", async () => {
    const completer = fake();
    expect(await runTick(deps(completer, "t2"), ids.loop, "scheduled")).toBe("no_op");
    expect(completer.calls.length).toBe(0);
    const [r] =
      await raw`select detail from agent_loop_run where id = ${derivedId("t2:run:gather")}`;
    expect(r?.detail).toBe("No new gathered content since latest generation");
  });

  test("a loop whose acting user lost access fails the tick and counts the failure", async () => {
    await raw`update agent_loop set acting_directus_user_id = ${"d1000000-0000-4000-8000-00000000dead"} where id = ${ids.loop}`;
    expect(await runTick(deps(fake(), "t3"), ids.loop, "manual")).toBe("error");
    const [loop] = await raw`select failure_count from agent_loop where id = ${ids.loop}`;
    expect(loop?.failure_count).toBe(1);
    const [gen] =
      await raw`select status, detail from canvas_generation where id = ${derivedId("t3:error-generation")}`;
    expect(gen).toMatchObject({ status: "error", detail: "403: User not onboarded" });
    await raw`update agent_loop set acting_directus_user_id = ${ids.user}, failure_count = 0 where id = ${ids.loop}`;
  });

  test("the reconciler gives an active loop without a pending tick a new one", async () => {
    await raw`update scheduled_task set status = 'completed' where task_type = 'canvas_tick'`;
    expect(await reconcileMissingTicks(deps(fake(), "t4"))).toBe(1);
    expect(await reconcileMissingTicks(deps(fake(), "t5"))).toBe(0);
  });

  test("the live stream sends connected, then the latest generation id per nudge", async () => {
    const sql = client(database.db);
    const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const app = new Hono();
    app.get("/events", (c) =>
      canvasEventStream(c, {
        sql,
        logger: quiet,
        reportId: ids.report,
        latestGenerationId: async () => "gen-1",
        heartbeatMs: 60_000,
      }),
    );
    const res = await app.request("/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const text = new TextDecoder();
    const first = text.decode((await reader.read()).value);
    expect(first).toBe('event: connected\ndata: {"type": "connected"}\n\n');
    await publishGenerationNudge(sql, ids.report);
    const second = text.decode((await reader.read()).value);
    expect(second).toBe(
      'event: generation\ndata: {"type": "generation", "generation_id": "gen-1"}\n\n',
    );
    await reader.cancel();
  });

  test("a preview renders the wall from the fake model's receipts without writing", async () => {
    const store = canvasStore(client(database.db));
    const before = await raw`select count(*)::int as n from canvas_generation`;
    const out = await previewCanvas(
      {
        access: new Access(new DrizzleAccessStore(database.db)),
        accessStore: new DrizzleAccessStore(database.db),
        store,
        canvasEnabled: true,
        completer: fake(),
        limiter: new RateLimiter(new MemoryRateCounter()),
        now: () => new Date(),
        startTick: async () => {},
        nudge: async () => {},
      },
      { appUserId: ids.appUser, directusUserId: ids.user, isStaff: false },
      { project_id: ids.project, brief: "Show the mood", gather_spec: null, tabs: null },
    );
    expect(out.content_html).toContain("Where should the next chargers go?");
    const after = await raw`select count(*)::int as n from canvas_generation`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

// ── crash and resume ────────────────────────────────────────────────

const trace = join(tmpdir(), `echo-canvas-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const traceLines = () => readFileSync(trace, "utf8").trim().split("\n");

async function until(check: () => boolean, ms = 40_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("canvas tick recovery", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill(9);
  });

  test("a tick on a killed worker resumes at the model call, not re-running prepare or gather", async () => {
    const url = await freshDatabase(admin as string, "canvas_recovery_test");
    await migrate(url);
    await installQueueSchema(url);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await seed(sql);
    writeFileSync(trace, "");
    const spawn = (executor: string, env: Record<string, string>) =>
      Bun.spawn(["bun", fixture], {
        env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });

    const first = spawn("worker-a", { START: "1", HANG: "1" });
    procs.push(first);
    await until(() => traceLines().includes("worker-a extract-start"));
    first.kill(9);

    const second = spawn("worker-b", {});
    procs.push(second);
    await until(() => traceLines().some((l) => l.startsWith("worker-b finished")));

    const lines = traceLines().filter((l) => !l.endsWith(" ready"));
    expect(lines).toEqual([
      "worker-a prepare",
      "worker-a gather",
      "worker-a extract-start",
      "worker-b extract-start",
      "worker-b extract-done",
      "worker-b host-guide",
      "worker-b finished ok",
    ]);
    const gens = await sql`select status from canvas_generation where report_id = ${ids.report}`;
    expect(gens.map((g) => g.status)).toEqual(["ok"]);
    await sql.end();
  });
});
