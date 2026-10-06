import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { FINISH_WINDOW_MS, finishReads, queueFinishRead } from "../src/finish";
import { goLive, type PopcornDeps, stopLive } from "../src/service";
import { client, type Row } from "../src/storage";
import { runPopcornTick } from "../src/tick/run";
import { dispatchDueTicks, type PopcornWorkerDeps, type TickArgs, tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { freshDatabase, ids, seed } from "./fixtures/tick/seed";

// A finished conversation books one popcorn read of its project, against Postgres.
// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

run("popcorn read when a conversation finishes", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_finish_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    raw = postgres(url, { max: 4, onnotice: () => {} });
    await seed(raw);
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  const workerDeps = (now: Date): PopcornWorkerDeps => ({
    db: database.db,
    logger: quiet,
    completer: new FakeCompleter(),
    flags: { present: true, canvas: true },
    participantBaseUrl: "http://localhost:5174",
    adminBaseUrl: "http://localhost:5173",
    databaseUrl: "unused",
    analysis: () => NO_ANALYSIS,
    now: () => now,
  });
  const finish = (projectId: string, now: Date) =>
    client(database.db).begin((tx) => queueFinishRead(tx, projectId, now)) as Promise<boolean>;
  const pending = () =>
    raw`select payload, scheduled_at from scheduled_task
      where task_type = 'popcorn_tick' and status = 'scheduled' order by scheduled_at`;
  const clear = () =>
    raw`update scheduled_task set status = 'completed' where task_type = 'popcorn_tick'`;
  const loopRow = async () =>
    (await raw`select * from agent_loop where id = ${ids.loop}`)[0] as Row;

  test("a finished conversation books one read a minute out", async () => {
    await clear();
    const now = new Date();
    expect(await finish(ids.project, now)).toBe(true);
    const rows = await pending();
    expect(rows.length).toBe(1);
    const payload = rows[0]?.payload as Record<string, string>;
    expect(payload.loop_id).toBe(ids.loop);
    expect(payload.tick_kind).toBe("finish");
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(rows[0]?.scheduled_at as string).getTime()).toBe(
      now.getTime() + FINISH_WINDOW_MS,
    );
  });

  test("two finishes close together queue one read, and the worker starts it once", async () => {
    await clear();
    const now = new Date();
    const [a, b] = await Promise.all([finish(ids.project, now), finish(ids.project, now)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await finish(ids.project, new Date(now.getTime() + 30_000))).toBe(false);
    expect((await pending()).length).toBe(1);

    // Before the window closes nothing is due; after it, one tick starts with the row's id.
    const started: TickArgs[] = [];
    const start = async (args: TickArgs) => {
      started.push(args);
    };
    expect(await dispatchDueTicks(workerDeps(new Date(now.getTime() + 30_000)), start)).toBe(0);
    expect(
      await dispatchDueTicks(workerDeps(new Date(now.getTime() + FINISH_WINDOW_MS + 1)), start),
    ).toBe(1);
    expect(started.length).toBe(1);
    expect(started[0]?.tickKind).toBe("finish");
    expect(started[0]?.workflowId).toBe(`popcorn-tick:${started[0]?.requestId}`);

    // Once that read has started, the next finish books a read of its own.
    expect(await finish(ids.project, new Date(now.getTime() + FINISH_WINDOW_MS + 2))).toBe(true);
  });

  test("a project without popcorn books nothing", async () => {
    await clear();
    expect(await finish(newId(), new Date())).toBe(false);
    expect((await pending()).length).toBe(0);
  });

  test("the hook books nothing with popcorn switched off, and a failure leaves the claim standing", async () => {
    await clear();
    const off = finishReads({ flags: { present: false, canvas: false }, logger: quiet });
    await client(database.db).begin((tx) => off(tx, ids.project, newId()));
    expect((await pending()).length).toBe(0);

    const warned: string[] = [];
    const logger = { ...(quiet as object), warn: (_o: unknown, m: string) => warned.push(m) };
    const on = finishReads({
      flags: { present: true, canvas: false },
      logger: logger as never,
      now: () => new Date(Number.NaN),
    });
    const after = await client(database.db).begin(async (tx) => {
      await on(tx, ids.project, newId());
      const [r] = await tx`select 1 as ok`;
      return r?.ok;
    });
    expect(after).toBe(1);
    expect(warned).toEqual(["popcorn finish read not booked"]);
    expect((await pending()).length).toBe(0);
  });

  // goLive and stopLive need only the database, the clock and the dispatcher.
  const liveDeps = (now: Date): PopcornDeps =>
    ({ db: database.db, now: () => now, dispatchTick: async () => {} }) as unknown as PopcornDeps;

  const kinds = async () =>
    (await pending()).map((r) => (r.payload as Record<string, string>).tick_kind);

  test("Stop live and Ready by keep a read a finished conversation booked", async () => {
    await clear();
    const now = new Date();
    await goLive(liveDeps(now), await loopRow(), 1);
    expect(await finish(ids.project, now)).toBe(true);
    await stopLive(liveDeps(now), await loopRow());
    expect(await kinds()).toEqual(["finish"]);
    await goLive(liveDeps(now), await loopRow(), 1, new Date(now.getTime() + 3_600_000));
    expect(await kinds()).toEqual(["finish", "start"]);
    await stopLive(liveDeps(now), await loopRow());
    expect(await kinds()).toEqual(["finish"]);
  });

  test("the read runs on a paused loop and leaves the mode and the live window alone", async () => {
    await clear();
    const before = await loopRow();
    expect(before.status).toBe("paused");
    // A held lease stops the read after the mode check, so no model is called.
    await raw`insert into platform_rate_limit (key, count, reset_at)
      values (${`popcorn:run:${ids.loop}`}, 1, now() + interval '5 minutes')`;
    const d = {
      ...tickDeps(workerDeps(new Date()), "w-finish", NO_ANALYSIS),
      manualLockWaitSeconds: 0,
    };
    const outcome = await runPopcornTick(d, ids.loop, "finish", newId());
    expect(outcome.status).toBe("duplicate");
    expect(outcome.run.detail).toBe("A tick is already running");
    await raw`delete from platform_rate_limit where key = ${`popcorn:run:${ids.loop}`}`;
    const after = await loopRow();
    expect(after.status).toBe("paused");
    expect(String(after.expires_at)).toBe(String(before.expires_at));
  });
});
