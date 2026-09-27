import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger, initTracing, withCorrelation } from "@echo/observability";
import postgres from "postgres";
import { z } from "zod";
import { defineJob, Queue } from "../src";

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

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

run("queue", () => {
  // pg-boss polls every 2s by default, so these tests wait on real time.
  setDefaultTimeout(20_000);
  let queue: Queue;
  let sql: postgres.Sql;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_test");
    await a.unsafe("create database queue_test");
    await a.end();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    queue = new Queue(url, logger, tracer, { manageSchema: true });
    await queue.start([greet, committed, flaky]);
  });
  afterAll(async () => {
    await queue.stop();
    await sql.end();
  });

  test("a job runs with its payload and carries the request that caused it", async () => {
    const seen: { name: string }[] = [];
    await queue.work(greet, { concurrency: 2 }, async (p) => {
      seen.push(p);
    });
    await withCorrelation({ requestId: "req-42" }, () => queue.enqueue(greet, { name: "ada" }));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ name: "ada" });
    await until(() => lines.some((l) => l.message === "job done" && l.job === "test.greet"));
    expect(lines.find((l) => l.message === "job done")?.caused_by_request_id).toBe("req-42");
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
    const rows =
      await sql`select 1 from pgboss.job where name = 'test.greet' and data->'payload'->>'name' = 'ghost'`;
    expect(rows.length).toBe(0);
  });

  test("a job enqueued in a committed transaction runs", async () => {
    const seen: string[] = [];
    await queue.work(committed, { concurrency: 1 }, async (p) => {
      seen.push(p.name);
    });
    await sql.begin(async (tx) => {
      await queue.enqueue(committed, { name: "committed" }, { tx });
    });
    await until(() => seen.includes("committed"));
  });

  test("a failing job is retried until it succeeds", async () => {
    let attempts = 0;
    await queue.work(flaky, { concurrency: 1 }, async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    });
    await queue.enqueue(flaky, { n: 1 });
    await until(() => attempts >= 2);
    const health = await queue.health();
    expect(health.map((h) => h.name).sort()).toEqual([
      "test.committed",
      "test.flaky",
      "test.greet",
    ]);
  });
});
