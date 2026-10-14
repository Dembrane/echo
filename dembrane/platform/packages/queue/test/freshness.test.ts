import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { migrate } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import { ExecutorHeartbeat, executorIdFor, installQueueSchema, workerFreshness } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_freshness_test` : "";
const logger = createLogger({ service: "t", release: "r", env: "test", level: "silent" });

run("worker freshness", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_freshness_test with (force)");
    await a.unsafe("create database queue_freshness_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql?.end();
  });

  test("no rows: no age, for any release", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    expect(await workerFreshness(sql)).toEqual({ ageS: null, jobAgeS: null });
    expect((await workerFreshness(sql, "new")).ageS).toBeNull();
  });

  test("a running executor's heartbeat carries its release and reads as fresh", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    const id = executorIdFor("new", "host-1");
    expect(id).toBe("new/host-1");
    const beat = new ExecutorHeartbeat(url, id, logger);
    await beat.start();
    try {
      const any = await workerFreshness(sql);
      expect(any.ageS).not.toBeNull();
      expect(any.ageS as number).toBeLessThan(5);
      expect((await workerFreshness(sql, "new")).ageS as number).toBeLessThan(5);
    } finally {
      await beat.stop();
    }
  });

  test("a stopping executor reads as fresh until it has stopped executing, then marks its row for the next sweep", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    const beat = new ExecutorHeartbeat(url, "new/host-2", logger, { beatMs: 50, deadAfterS: 60 });
    await beat.start();
    await sql`insert into dbos.workflow_status (workflow_uuid, status, name, executor_id)
              values ('wf-running', 'PENDING', 'job', 'new/host-2')`;
    try {
      let ageWhileStopping: number | null = null;
      await beat.stop(async () => {
        // Aged by hand: only a beat during the stop makes it fresh again.
        await sql`update dbos_executor_heartbeat set last_seen = now() - interval '30 seconds'`;
        await Bun.sleep(300);
        ageWhileStopping = (await workerFreshness(sql, "new")).ageS;
      });

      expect(ageWhileStopping as unknown as number).toBeLessThan(5);
      const rows = await sql`select executor_id, last_seen from dbos_executor_heartbeat`;
      expect([...rows]).toEqual([{ executor_id: "new/host-2", last_seen: new Date(0) }]);
    } finally {
      await sql`delete from dbos.workflow_status where workflow_uuid = 'wf-running'`;
    }
  });

  test("an executor whose stop fails keeps an ordinary row, which goes stale like any other", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    const beat = new ExecutorHeartbeat(url, "new/host-3", logger);
    await beat.start();

    await expect(
      beat.stop(async () => {
        throw new Error("still executing");
      }),
    ).rejects.toThrow("still executing");

    expect((await workerFreshness(sql, "new")).ageS as number).toBeLessThan(5);
  });

  test("stale: the newest heartbeat's age grows past the threshold", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    await sql`insert into dbos_executor_heartbeat (executor_id, last_seen)
              values ('new/a', now() - interval '5 minutes'), ('new/b', now() - interval '2 minutes')`;
    const f = await workerFreshness(sql, "new");
    expect(Math.round(f.ageS as number)).toBe(120);
  });

  test("old release: a fresh leftover does not count for the new build", async () => {
    await sql`delete from dbos_executor_heartbeat`;
    // A release that is a prefix of another does not match it, nor does an id without one.
    await sql`insert into dbos_executor_heartbeat (executor_id, last_seen)
              values ('old/a', now()), ('newer/a', now()), ('worker-1234', now())`;
    expect((await workerFreshness(sql, "new")).ageS).toBeNull();
    expect((await workerFreshness(sql, "old")).ageS as number).toBeLessThan(5);
    expect((await workerFreshness(sql)).ageS as number).toBeLessThan(5);
  });

  test("the last finished job counts, one outside 15 minutes does not", async () => {
    const nowMs = Date.now();
    await sql`delete from dbos.workflow_status`;
    await sql`insert into dbos.workflow_status (workflow_uuid, status, name, created_at, updated_at)
              values ('wf-old', 'SUCCESS', 'heartbeat', ${nowMs - 3_600_000}, ${nowMs - 3_600_000})`;
    expect((await workerFreshness(sql)).jobAgeS).toBeNull();
    await sql`insert into dbos.workflow_status (workflow_uuid, status, name, created_at, updated_at)
              values ('wf-new', 'SUCCESS', 'heartbeat', ${nowMs - 20_000}, ${nowMs - 10_000}),
                     ('wf-err', 'ERROR', 'heartbeat', ${nowMs - 2_000}, ${nowMs - 1_000})`;
    expect(Math.round((await workerFreshness(sql)).jobAgeS as number)).toBeGreaterThanOrEqual(9);
    expect(Math.round((await workerFreshness(sql)).jobAgeS as number)).toBeLessThan(15);
  });
});
