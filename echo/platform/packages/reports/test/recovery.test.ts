import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@dembrane/db";
import { installQueueSchema } from "@dembrane/queue";
import postgres from "postgres";

// Runs against its own database on the Postgres named by TEST_DATABASE_ADMIN_URL, never
// the parity databases.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/reports_recovery_test` : "";
const trace = join(tmpdir(), `echo-report-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const PROJECT = "f0000000-0000-4000-8000-00000000aa01";
const CONVERSATION = "c1000000-0000-4000-8000-00000000aa01";

function spawn(executor: string, env: Record<string, string>) {
  return Bun.spawn(["bun", fixture], {
    env: {
      ...process.env,
      QUEUE_URL: url,
      TRACE_FILE: trace,
      EXECUTOR: executor,
      PROJECT_ID: PROJECT,
      REPORT_ID: "1",
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}
const lines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => boolean, ms = 45_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("report generation survives a killed worker", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill(9);
  });

  test("a worker killed inside generate is resumed elsewhere without summarising again", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists reports_recovery_test with (force)");
    await a.unsafe("create database reports_recovery_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Crash', 'en', true, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${CONVERSATION}, ${PROJECT}, 'Resident', now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, created_at, updated_at)
      values ('c2000000-0000-4000-8000-00000000aa01', ${CONVERSATION}, now(), 'The buses stop at eleven.', now(), now())`;
    await sql`insert into project_report (project_id, status, language, kind, content, date_created)
      values (${PROJECT}, 'draft', 'en', 'report', '', now())`;
    writeFileSync(trace, "");

    const first = spawn("worker-a", { START: "1", HANG: "1" });
    procs.push(first);
    await until(() => lines().includes("worker-a step generate"));
    first.kill(9);

    const second = spawn("worker-b", {});
    procs.push(second);
    await until(() => lines().includes("worker-b webhook"));

    const work = lines().filter((l) => !l.endsWith(" ready"));
    expect(work).toEqual([
      `worker-a step summarize:${CONVERSATION}`,
      "worker-a model summary",
      "worker-a step generate",
      "worker-b step generate",
      "worker-b model report",
      "worker-b webhook",
    ]);
    const [report] = await sql`select status, content, error_code from project_report where id = 1`;
    expect(report).toEqual({
      status: "archived",
      content: "# Crash-safe report\n\nResidents want buses.",
      error_code: null,
    });
    const [conv] = await sql`select summary from conversation where id = ${CONVERSATION}`;
    expect(conv?.summary).toBe("Residents want later buses.");
    const events =
      await sql`select event from processing_status where project_id = ${PROJECT} order by id`;
    expect(events.map((e) => e.event)).toEqual([
      "task_create_report.completed",
      "task_create_report_continue.completed",
    ]);
    await sql.end();
    // Two worker processes, a kill and a DBOS recovery sweep: seconds alone, far longer while
    // the whole suite runs in parallel. The explicit limit holds under --parallel, where the
    // describe-level default was not applied and the test failed at 15 s.
  }, 90_000);
});
