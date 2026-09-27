import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@echo/db";
import { FakeCompleter } from "@echo/llm";
import { createLogger, initTracing } from "@echo/observability";
import { installQueueSchema, Queue } from "@echo/queue";
import postgres from "postgres";
import { NO_OBJECTS } from "../src/deck";
import { popcornTick } from "../src/jobs";
import {
  dispatchDueTicks,
  type PopcornWorkerDeps,
  popcornWorker,
  type TickArgs,
} from "../src/worker";
import { freshDatabase, ids, seed } from "./fixtures/tick/seed";

// The tick as the worker runs it: a job becomes the durable workflow, and a second delivery
// of the same request joins the first run instead of reading again.
// Needs a scratch Postgres: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const REQUEST = "33333333-3333-4333-8333-333333333333";

async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(100);
  }
}

run("popcorn tick workflow on DBOS", () => {
  setDefaultTimeout(40_000);
  let url = "";
  let raw: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  let queue: Queue;
  let deps: PopcornWorkerDeps;
  const fake = new FakeCompleter().on("Transcript id:", JSON.stringify({ items: [] }));
  const logger = createLogger({ service: "t", release: "r", env: "test", level: "error" });
  const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });

  beforeAll(async () => {
    url = await freshDatabase(admin as string, "popcorn_workflow_test");
    await migrate(url);
    await installQueueSchema(url);
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
    // A presentation with popcorn alone: the read extracts and nothing else.
    await raw`update canvas_config_revision set popcorn_settings = ${raw.json({
      title: "City session",
      presentation: { blocks: ["popcorn"] },
    })}`;
    database = createDb({ url, poolMax: 4 });
    deps = {
      db: database.db,
      logger,
      completer: fake,
      flags: { present: true, canvas: true },
      participantBaseUrl: "http://localhost:5174",
      adminBaseUrl: "http://localhost:5173",
      databaseUrl: url,
      deck: {
        deckObjects: async () => NO_OBJECTS,
        excludedObjectIds: async () => new Set(),
        currentDeck: async () => null,
        ownsAny: async () => false,
      },
    };
    queue = new Queue(url, logger, tracer, { pollingIntervalMs: 50 });
    const worker = popcornWorker(deps);
    await queue.start(worker.jobs);
    await worker.register(queue);
    await queue.run();
  });
  afterAll(async () => {
    await queue?.stop();
    await raw?.end();
    await database?.close();
  });

  test("a dispatched request runs once, however often it is delivered", async () => {
    await queue.enqueue(popcornTick, { loopId: ids.loop, tickKind: "manual", requestId: REQUEST });
    await until(async () => {
      const [r] = await raw`select status from agent_loop_run where id = ${REQUEST}`;
      return r?.status === "ok";
    });
    const calls = fake.calls.length;
    expect(calls).toBe(2);
    await queue.enqueue(popcornTick, { loopId: ids.loop, tickKind: "manual", requestId: REQUEST });
    await Bun.sleep(1500);
    const runs = await raw`select id from agent_loop_run where loop_id = ${ids.loop}`;
    expect(runs.length).toBe(1);
    expect(fake.calls.length).toBe(calls);
    const [loop] = await raw`select popcorn_state from agent_loop where id = ${ids.loop}`;
    expect(loop?.popcorn_state).toMatchObject({ run: 1 });
  });

  test("due rows start one tick each, under the request's own workflow id", async () => {
    await raw`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
      values ('44444444-4444-4444-8444-444444444444', 'popcorn_tick',
        ${raw.json({ loop_id: ids.loop, tick_kind: "manual", request_id: REQUEST })}, now(), 'scheduled', 0, now(), now()),
      ('55555555-5555-4555-8555-555555555555', 'popcorn_tick', ${raw.json({ tick_kind: "scheduled" })}, now(), 'scheduled', 0, now(), now())`;
    const started: TickArgs[] = [];
    expect(
      await dispatchDueTicks(deps, async (a) => {
        started.push(a);
      }),
    ).toBe(2);
    expect(started).toEqual([
      {
        workflowId: `popcorn-tick:${REQUEST}`,
        loopId: ids.loop,
        tickKind: "manual",
        requestId: REQUEST,
      },
    ]);
    const rows = await raw`select id, status, error from scheduled_task
      where id in ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555') order by id`;
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["completed", null],
      ["failed", "popcorn_tick payload missing loop_id"],
    ]);
  });
});
