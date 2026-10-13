import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { migrate } from "@dembrane/db";
import { createLogger, initTracing } from "@dembrane/observability";
import postgres from "postgres";
import { z } from "zod";
import { defineJob, installQueueSchema, type JobDefinition, Queue } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_set_aside_test` : "";

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
const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });

// Declared and enqueued but never worked here: a job stays where recovery leaves it.
const analysis = defineJob("test.analysis", z.object({}));
const transcription = defineJob("test.transcription", z.object({}), { lostWorkerLimit: 10 });

async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

run("a job that keeps losing its worker", () => {
  setDefaultTimeout(60_000);
  let queue: Queue;
  let sql: postgres.Sql;
  let workers = 0;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_set_aside_test with (force)");
    await a.unsafe("create database queue_set_aside_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    sql = postgres(url, { max: 2, onnotice: () => {} });
    // This process is the live worker whose sweep finds the stopped ones.
    queue = new Queue(url, logger, tracer, { recovery: { beatMs: 50, deadAfterS: 60 } });
    await queue.start([analysis, transcription]);
    await queue.run();
  });
  afterAll(async () => {
    await queue.stop();
    await sql.end();
  });

  const enqueue = async (def: JobDefinition) => (await queue.enqueue(def, {})) as string;

  /**
   * A worker takes these jobs off their queues and stops: they are left running under an
   * executor whose heartbeat is stale. Returns once the sweep has dealt with that executor.
   */
  async function loseWorker(...ids: string[]) {
    const executor = `stopped-${++workers}`;
    await sql.begin(async (tx) => {
      await tx`update dbos.workflow_status set status = 'PENDING', executor_id = ${executor}
               where workflow_uuid = any(${ids}) and status = 'ENQUEUED'`;
      await tx`insert into dbos_executor_heartbeat (executor_id, last_seen)
               values (${executor}, now() - interval '1 hour')`;
    });
    await until(
      async () =>
        (await sql`select 1 from dbos_executor_heartbeat where executor_id = ${executor}`)
          .length === 0,
    );
    return executor;
  }
  async function loseWorkerTimes(n: number, ...ids: string[]) {
    for (let i = 0; i < n; i++) await loseWorker(...ids);
  }

  /** Where recovery left a job: its DBOS status and queue, and its count row if it has one. */
  async function job(id: string) {
    const [row] = await sql`
      select w.status, w.queue_name as queue, c.lost, c.queue_name as kept_queue,
        c.set_aside_at is not null as set_aside
      from dbos.workflow_status w
      left join dbos_workflow_lost_worker c on c.workflow_id = w.workflow_uuid
      where w.workflow_uuid = ${id}`;
    return row;
  }
  const resumed = (queueName: string, lost: number) => ({
    status: "ENQUEUED",
    queue: queueName,
    lost,
    kept_queue: queueName,
    set_aside: false,
  });
  const setAside = (queueName: string, lost: number) => ({
    status: "CANCELLED",
    queue: null,
    lost,
    kept_queue: queueName,
    set_aside: true,
  });
  const setAsideLines = (id: string) =>
    lines.filter((l) => l.signal === "queue.job_set_aside" && l.job_id === id);
  const healthOf = async (def: JobDefinition) =>
    (await queue.health()).find((q) => q.name === def.name);

  test("a job that loses its worker once goes back on its queue", async () => {
    const id = await enqueue(analysis);
    const executor = await loseWorker(id);

    expect(await job(id)).toEqual(resumed("test.analysis", 1));
    expect(setAsideLines(id)).toEqual([]);
    expect(lines.find((l) => l.deadExecutor === executor)).toMatchObject({
      severity: "WARNING",
      message: "resumed workflows of a dead worker",
      resumed: 1,
    });
  });

  test("a job is resumed up to its limit and set aside at the next lost worker", async () => {
    const id = await enqueue(analysis);
    for (const lost of [1, 2, 3]) {
      await loseWorker(id);
      expect(await job(id)).toEqual(resumed("test.analysis", lost));
    }
    expect((await healthOf(analysis))?.setAside).toBe(0);

    const executor = await loseWorker(id);

    expect(await job(id)).toEqual(setAside("test.analysis", 4));
    expect(setAsideLines(id)).toEqual([
      expect.objectContaining({
        severity: "ERROR",
        message: "job set aside after losing its worker repeatedly",
        job: "test.analysis",
        queue: "test.analysis",
        lost: 4,
        limit: 3,
      }),
    ]);
    // Nothing was resumed for that worker, so its resume line stays out.
    expect(lines.some((l) => l.deadExecutor === executor)).toBe(false);
    expect((await healthOf(analysis))?.setAside).toBe(1);
    expect((await healthOf(transcription))?.setAside).toBe(0);
  });

  test("a job that lost its worker less often is resumed in the sweep that sets another aside", async () => {
    const often = await enqueue(analysis);
    const once = await enqueue(analysis);
    await loseWorkerTimes(3, often);

    await loseWorker(often, once);

    expect(await job(often)).toEqual(setAside("test.analysis", 4));
    expect(await job(once)).toEqual(resumed("test.analysis", 1));
  });

  test("a job with a higher limit is resumed where a default job is set aside", async () => {
    const quick = await enqueue(analysis);
    const patient = await enqueue(transcription);

    await loseWorkerTimes(4, quick, patient);

    expect(await job(quick)).toEqual(setAside("test.analysis", 4));
    expect(await job(patient)).toEqual(resumed("test.transcription", 4));

    await loseWorkerTimes(6, patient);
    expect(await job(patient)).toEqual(resumed("test.transcription", 10));
    await loseWorker(patient);
    expect(await job(patient)).toEqual(setAside("test.transcription", 11));
  });

  test("of the jobs past their limit, a sweep sets aside only the one that lost its worker most often", async () => {
    const long = await enqueue(transcription);
    const late = await enqueue(analysis);
    await loseWorkerTimes(7, long);

    await loseWorkerTimes(4, long, late);

    expect(await job(long)).toEqual(setAside("test.transcription", 11));
    expect(await job(late)).toEqual(resumed("test.analysis", 4));

    await loseWorker(late);
    expect(await job(late)).toEqual(setAside("test.analysis", 5));
  });

  test("jobs past their limit that lost their worker equally often are set aside together", async () => {
    const a = await enqueue(analysis);
    const b = await enqueue(analysis);

    await loseWorkerTimes(4, a, b);

    expect(await job(a)).toEqual(setAside("test.analysis", 4));
    expect(await job(b)).toEqual(setAside("test.analysis", 4));
  });

  test("a finished job's count is forgotten", async () => {
    const id = await enqueue(analysis);
    await loseWorkerTimes(2, id);
    expect((await job(id))?.lost).toBe(2);

    await sql`update dbos.workflow_status set status = 'SUCCESS' where workflow_uuid = ${id}`;

    await until(async () => (await job(id))?.lost === null);
  });

  test("a set-aside job a person resumes goes back on its queue and starts from zero", async () => {
    const id = await enqueue(analysis);
    await loseWorkerTimes(4, id);
    const before = (await healthOf(analysis))?.setAside as number;
    expect((await job(id))?.status).toBe("CANCELLED");

    await DBOS.resumeWorkflow(id, { queueName: (await job(id))?.kept_queue });

    await until(async () => (await job(id))?.lost === null);
    expect(await job(id)).toMatchObject({ status: "ENQUEUED", queue: "test.analysis" });
    expect((await healthOf(analysis))?.setAside).toBe(before - 1);
    await loseWorker(id);
    expect(await job(id)).toEqual(resumed("test.analysis", 1));
  });
});
