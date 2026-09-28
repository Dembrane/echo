import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { migrate } from "@dembrane/db";
import { createLogger, initTracing, withCorrelation } from "@dembrane/observability";
import postgres from "postgres";
import { z } from "zod";
import { defineJob, installQueueSchema, Queue } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_test` : "";

const lines: Record<string, unknown>[] = [];
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "info" },
  new Writable({
    write(c, _e, cb) {
      lines.push(JSON.parse(c.toString()));
      cb();
    },
  }),
);
const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 1 });

const greet = defineJob("test.greet", z.object({ name: z.string() }), {
  retryLimit: 2,
  retryDelaySeconds: 1,
  retryBackoff: false,
});
const committed = defineJob("test.committed", z.object({ name: z.string() }));
const flaky = defineJob("test.flaky", z.object({ n: z.number() }), {
  retryLimit: 3,
  retryDelaySeconds: 1,
  retryBackoff: false,
});
const once = defineJob("test.once", z.object({ k: z.string() }));
const tick = defineJob("test.tick", z.object({}), { policy: "singleton", retryLimit: 0 });

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

run("queue on DBOS", () => {
  setDefaultTimeout(30_000);
  let queue: Queue;
  let sql: postgres.Sql;
  const greeted: string[] = [];
  const committedNames: string[] = [];
  const onceRuns: string[] = [];
  let flakyAttempts = 0;
  let ticks = 0;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_test with (force)");
    await a.unsafe("create database queue_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    sql = postgres(url, { max: 2, onnotice: () => {} });
    queue = new Queue(url, logger, tracer, { pollingIntervalMs: 50 });
    await queue.start([greet, committed, flaky, once, tick]);
    await queue.work(greet, { concurrency: 2 }, async (p) => {
      greeted.push(p.name);
    });
    await queue.work(committed, { concurrency: 1 }, async (p) => {
      committedNames.push(p.name);
    });
    await queue.work(flaky, { concurrency: 1 }, async () => {
      flakyAttempts++;
      if (flakyAttempts < 2) throw new Error("transient");
    });
    await queue.work(once, { concurrency: 1 }, async (p) => {
      onceRuns.push(p.k);
      await Bun.sleep(300);
    });
    await queue.work(tick, { concurrency: 1 }, async () => {
      ticks++;
    });
    await queue.schedule(tick, "* * * * * *", {});
    await queue.run();
  });
  afterAll(async () => {
    await queue.stop();
    await sql.end();
  });

  test("a job runs with its payload and carries the request that caused it", async () => {
    await withCorrelation({ requestId: "req-42" }, () => queue.enqueue(greet, { name: "ada" }));
    await until(() => greeted.includes("ada"));
    await until(() => lines.some((l) => l.message === "job done" && l.job === "test.greet"));
    expect(
      lines.find((l) => l.message === "job done" && l.job === "test.greet")?.caused_by_request_id,
    ).toBe("req-42");
  });

  test("an invalid payload is refused at enqueue, not discovered by the worker", async () => {
    await expect(queue.enqueue(greet, { name: 7 } as never)).rejects.toThrow();
  });

  test("a job enqueued in a rolled-back transaction never exists", async () => {
    await sql
      .begin(async (tx) => {
        await queue.enqueue(greet, { name: "ghost" }, { tx });
        throw new Error("rollback");
      })
      .catch(() => {});
    await Bun.sleep(400);
    expect(greeted).not.toContain("ghost");
    const rows =
      await sql`select 1 from dbos.workflow_status where name = 'test.greet' and inputs like '%ghost%'`;
    expect(rows.length).toBe(0);
  });

  test("a job enqueued in a committed transaction runs", async () => {
    await sql.begin(async (tx) => {
      await queue.enqueue(committed, { name: "kept" }, { tx });
    });
    await until(() => committedNames.includes("kept"));
  });

  test("a failing job is retried until it succeeds", async () => {
    await queue.enqueue(flaky, { n: 1 });
    await until(() => flakyAttempts >= 2);
  });

  test("a singleton key keeps one queued or running job per key", async () => {
    const a = await queue.enqueue(once, { k: "x" }, { singletonKey: "x" });
    const b = await queue.enqueue(once, { k: "x" }, { singletonKey: "x" });
    expect(b).toBe(a);
    await until(() => onceRuns.length >= 1);
    await Bun.sleep(400);
    expect(onceRuns).toEqual(["x"]);
  });

  test("a schedule fires", async () => {
    await until(() => ticks >= 2);
  });

  test("health reports every queue", async () => {
    const h = await queue.health();
    expect(h.map((q) => q.name).sort()).toEqual([
      "test.committed",
      "test.flaky",
      "test.greet",
      "test.once",
      "test.tick",
    ]);
  });
});
