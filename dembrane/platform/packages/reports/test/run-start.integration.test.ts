import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@dembrane/db";
import { installQueueSchema } from "@dembrane/queue";
import postgres from "postgres";

// The guard step restarts a free draft's sweep timer when its run starts.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/reports_run_start_test` : "";
const trace = join(tmpdir(), `echo-report-run-start-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const PROJECT = "f0000000-0000-4000-8000-00000000ab01";
const CONVERSATION = "c1000000-0000-4000-8000-00000000ab01";
const OLD = "2026-01-01T00:00:00.000Z";

const lines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => boolean, ms = 45_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("a free report's run start", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill(9);
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists reports_run_start_test with (force)");
    await a.end();
  });

  test("moves a stamped draft's date_updated to the start of the run", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists reports_run_start_test with (force)");
    await a.unsafe("create database reports_run_start_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Start', 'en', true, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${CONVERSATION}, ${PROJECT}, 'Resident', now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, created_at, updated_at)
      values ('c2000000-0000-4000-8000-00000000ab01', ${CONVERSATION}, now(), 'The buses stop at eleven.', now(), now())`;
    await sql`insert into project_report (project_id, status, language, kind, content, date_created, date_updated, free_period_start)
      values (${PROJECT}, 'draft', 'en', 'report', '', ${OLD}, ${OLD}, '2026-10-01T00:00:00Z')`;
    writeFileSync(trace, "");

    const started = Date.now();
    const worker = Bun.spawn(["bun", fixture], {
      env: {
        ...process.env,
        QUEUE_URL: url,
        TRACE_FILE: trace,
        EXECUTOR: "worker-a",
        PROJECT_ID: PROJECT,
        REPORT_ID: "1",
        START: "1",
        HANG: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(worker);
    await until(() => lines().includes("worker-a step generate"));
    worker.kill(9);

    const [report] = await sql`select status, date_updated from project_report where id = 1`;
    expect(report?.status).toBe("draft");
    expect(new Date(report?.date_updated as Date).getTime()).toBeGreaterThanOrEqual(
      started - 30_000,
    );
    await sql.end();
  }, 90_000);
});
