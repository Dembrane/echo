import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { migrate } from "@dembrane/db";
import { createLogger, initTracing } from "@dembrane/observability";
import postgres from "postgres";
import { installQueueSchema, Queue } from "../src";
import { impatient, ordinary } from "./fixtures/jobs";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_recovery_test` : "";
const trace = join(tmpdir(), `echo-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;

function spawn(executor: string, env: Record<string, string>) {
  return Bun.spawn(["bun", fixture], {
    env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
}
const traceLines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}
async function freshDatabase() {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe("drop database if exists queue_recovery_test with (force)");
  await a.unsafe("create database queue_recovery_test");
  await a.end();
  await migrate(url, { appEnv: "test" });
  await installQueueSchema(url);
  writeFileSync(trace, "");
}

run("dead worker recovery", () => {
  setDefaultTimeout(60_000);
  const procs: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill(9);
  });

  test("a workflow on a killed worker resumes on another worker without re-running finished steps", async () => {
    await freshDatabase();

    const first = spawn("worker-a", { START: "1", HANG: "1" });
    procs.push(first);
    await until(() => traceLines().includes("worker-a second start pipe-1"));
    first.kill(9);

    const second = spawn("worker-b", {});
    procs.push(second);
    await until(() => traceLines().includes("worker-b finished pipe-1"));

    const lines = traceLines().filter((l) => l.includes("pipe-1"));
    expect(lines).toEqual([
      "worker-a first pipe-1",
      "worker-a second start pipe-1",
      "worker-b second start pipe-1",
      "worker-b second done pipe-1",
      "worker-b finished pipe-1",
    ]);
  });

  test("a job that loses every worker is set aside, the job beside it finishes, and a person resumes the first", async () => {
    await freshDatabase();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const jobs = new Queue(
      url,
      createLogger({ service: "t", release: "r", env: "test", level: "silent" }),
      initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 }).tracer,
    );
    const dbos = await DBOSClient.create({
      systemDatabaseUrl: url,
      systemDatabaseSchemaName: "dbos",
    });
    const status = async (id: string) =>
      (await sql`select status from dbos.workflow_status where workflow_uuid = ${id}`)[0]?.status;
    const counts = () =>
      sql`select workflow_id, queue_name, lost, set_aside_at is not null as set_aside
          from dbos_workflow_lost_worker order by workflow_id`;
    const has = (line: string) => traceLines().includes(line);
    try {
      await jobs.start([impatient, ordinary]);
      await jobs.enqueue(impatient, { id: "stuck" }, { workflowId: "stuck" });
      await jobs.enqueue(ordinary, { id: "beside" }, { workflowId: "beside" });

      // Both jobs are running when the first worker stops; on the next one only "stuck" hangs.
      const a = spawn("worker-a", { HANG_JOBS: "stuck,beside" });
      procs.push(a);
      await until(() => has("worker-a second start stuck") && has("worker-a second start beside"));
      a.kill(9);

      const b = spawn("worker-b", { HANG_JOBS: "stuck" });
      procs.push(b);
      await until(() => has("worker-b second start stuck") && has("worker-b finished beside"));
      b.kill(9);

      const c = spawn("worker-c", { HANG_JOBS: "stuck" });
      procs.push(c);
      await until(() => has("worker-c second start stuck"));
      c.kill(9);

      // The third lost worker passes the job's limit of two: the next worker leaves it alone.
      procs.push(spawn("worker-d", {}));
      await until(async () => (await status("stuck")) === "CANCELLED");
      await until(async () => (await counts()).every((c) => c.set_aside) && has("worker-d ready"));
      expect([...(await counts())]).toEqual([
        { workflow_id: "stuck", queue_name: "test.impatient", lost: 3, set_aside: true },
      ]);
      expect(await status("beside")).toBe("SUCCESS");
      expect(traceLines().filter((l) => l.startsWith("worker-d"))).toEqual(["worker-d ready"]);

      // A person resumes it on the queue its count row kept; it continues after step one.
      const [kept] = await counts();
      await dbos.resumeWorkflow("stuck", { queueName: kept?.queue_name });
      await until(() => has("worker-d finished stuck"));
      await until(async () => (await counts()).length === 0);
      expect(await status("stuck")).toBe("SUCCESS");
      expect(traceLines().filter((l) => l.endsWith("first stuck"))).toEqual([
        "worker-a first stuck",
      ]);
    } finally {
      await dbos.destroy();
      await jobs.stop();
      await sql.end();
    }
  });
});
