import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@dembrane/db";
import postgres from "postgres";
import { installQueueSchema } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_stop_test` : "";
const trace = join(tmpdir(), `echo-stop-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;

// Workers here presume a silent worker dead only after longer than any test waits, so a
// resume cannot come from that: it comes from the worker that stopped saying so.
function spawn(executor: string, env: Record<string, string>) {
  return Bun.spawn(["bun", fixture], {
    env: {
      ...process.env,
      QUEUE_URL: url,
      TRACE_FILE: trace,
      EXECUTOR: executor,
      DEAD_AFTER_S: "600",
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}
const traceLines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("a worker that stops", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  const procs: ReturnType<typeof spawn>[] = [];
  afterEach(async () => {
    for (const p of procs.splice(0)) p.kill(9);
    await sql?.end();
  });

  async function freshDatabase() {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_stop_test with (force)");
    await a.unsafe("create database queue_stop_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    writeFileSync(trace, "");
    sql = postgres(url, { max: 1, onnotice: () => {} });
  }
  /** The executors with a heartbeat row: what another worker's sweep reads. */
  const executors = async () =>
    (await sql`select executor_id from dbos_executor_heartbeat order by 1`).map(
      (r) => r.executor_id as string,
    );
  /** A worker running pipe-1, stopped in the middle of step two the way a rollout stops it. */
  async function stopMidRun() {
    const first = spawn("worker-a", { START: "1", HANG: "1" });
    procs.push(first);
    await until(() => traceLines().includes("worker-a second start pipe-1"));
    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);
  }

  test("its running workflow resumes on another worker at once, without re-running finished steps", async () => {
    await freshDatabase();
    procs.push(spawn("worker-b", {}));
    await until(() => traceLines().includes("worker-b ready"));

    await stopMidRun();

    await until(() => traceLines().includes("worker-b finished pipe-1"));
    expect(traceLines().filter((l) => l.includes("pipe-1"))).toEqual([
      "worker-a first pipe-1",
      "worker-a second start pipe-1",
      "worker-b second start pipe-1",
      "worker-b second done pipe-1",
      "worker-b finished pipe-1",
    ]);
    await until(async () => (await executors()).join() === "worker-b");
  });

  test("with no other worker alive, its running workflow resumes on the next one that starts", async () => {
    await freshDatabase();

    await stopMidRun();
    expect(await executors()).toEqual(["worker-a"]);

    procs.push(spawn("worker-b", {}));
    await until(() => traceLines().includes("worker-b finished pipe-1"));
    await until(async () => (await executors()).join() === "worker-b");
  });

  test("with nothing running it leaves no heartbeat behind", async () => {
    await freshDatabase();
    const only = spawn("worker-a", {});
    procs.push(only);
    await until(() => traceLines().includes("worker-a ready"));
    expect(await executors()).toEqual(["worker-a"]);

    only.kill("SIGTERM");
    expect(await only.exited).toBe(0);

    expect(await executors()).toEqual([]);
  });
});
