import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@echo/db";
import postgres from "postgres";
import { installQueueSchema } from "../src";

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
async function until(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("dead worker recovery", () => {
  setDefaultTimeout(60_000);
  const procs: ReturnType<typeof spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill(9);
  });

  test("a workflow on a killed worker resumes on another worker without re-running finished steps", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_recovery_test with (force)");
    await a.unsafe("create database queue_recovery_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    writeFileSync(trace, "");

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
});
