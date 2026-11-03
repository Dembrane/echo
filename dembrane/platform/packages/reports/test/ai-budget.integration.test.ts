import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_SPEND_KEY, periodStart } from "@dembrane/allowance";
import { createDb, migrate } from "@dembrane/db";
import { installQueueSchema } from "@dembrane/queue";
import postgres from "postgres";
import { runScheduledReports } from "../src/jobs";
import { reportsStorage } from "../src/storage";

// A scheduled report whose run starts with the free AI budget used up ends in error, unasked.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = "reports_ai_budget_test";
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";
const trace = join(tmpdir(), `echo-report-ai-budget-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const ORG = "f0000000-0000-4000-8000-00000000dd00";
const BILLING = "f0000000-0000-4000-8000-00000000dd01";
const WS = "f0000000-0000-4000-8000-00000000dd02";
const PROJECT = "f0000000-0000-4000-8000-00000000dd03";
const CONVERSATION = "c1000000-0000-4000-8000-00000000dd01";
const LIMIT = 5_000_000;
// The worker reads the budget at this instant too, so a run across midnight on the 1st can't flake.
const NOW = new Date();

const lines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => Promise<boolean> | boolean, ms = 45_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(100);
  }
}

run("a scheduled report and the AI budget", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  afterAll(async () => {
    for (const p of procs) p.kill(9);
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const spawn = (executor: string, reportId: number) => {
    const p = Bun.spawn(["bun", fixture], {
      env: {
        ...process.env,
        QUEUE_URL: url,
        TRACE_FILE: trace,
        EXECUTOR: executor,
        PROJECT_ID: PROJECT,
        REPORT_ID: String(reportId),
        START: "1",
        BUDGET_NOW: NOW.toISOString(),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(p);
    return p;
  };

  async function spend(amount: number) {
    const period = periodStart(NOW, "free", null);
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${BILLING}, ${period.toISOString()}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  // The scheduler flips a due report to draft and hands back the run it enqueues.
  async function due(): Promise<number> {
    const [r] = await sql`insert into project_report
        (project_id, status, language, kind, content, date_created, scheduled_at)
      values (${PROJECT}, 'scheduled', 'en', 'report', '', now(), now() - interval '1 minute')
      returning id::int`;
    const id = r?.id as number;
    await sql`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
      values (gen_random_uuid(), 'generate_report', ${{ report_id: id, project_id: PROJECT } as never},
        now() - interval '1 minute', 'scheduled', 0, now(), now())`;
    const enqueued: unknown[] = [];
    await runScheduledReports({
      store: reportsStorage(database.db),
      jobs: { enqueue: async (_def, payload) => enqueued.push(payload) },
    });
    expect(enqueued).toMatchObject([{ projectId: PROJECT, reportId: id }]);
    return id;
  }

  const report = async (id: number) =>
    (
      await sql`select status, error_code, error_message, content from project_report where id = ${id}`
    )[0];

  test("at zero the run ends in error with AI_BUDGET_USED_UP and makes no model call", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    database = createDb({ url, poolMax: 2 });
    await sql`insert into org (id, name) values (${ORG}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${BILLING}, ${ORG}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${WS}, 'W', ${ORG}, ${BILLING})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Budget', 'en', ${WS}, true, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${CONVERSATION}, ${PROJECT}, 'Resident', now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, created_at, updated_at)
      values ('c2000000-0000-4000-8000-00000000dd01', ${CONVERSATION}, now(), 'The buses stop at eleven.', now(), now())`;
    await spend(LIMIT);
    writeFileSync(trace, "");

    const id = await due();
    const worker = spawn("worker-a", id);
    try {
      await until(async () => (await report(id))?.status === "error");
      expect(await report(id)).toEqual({
        status: "error",
        error_code: "AI_BUDGET_USED_UP",
        error_message: "This month's AI budget is used up.",
        content: "",
      });
      // Give the run a moment to show it stopped at the guard.
      await Bun.sleep(1_000);
      expect(lines().filter((l) => !l.endsWith(" ready"))).toEqual([]);
      // A refused run is a failed phase for the project's processing status.
      const events = await sql`select event, message from processing_status
        where project_id = ${PROJECT} and message like ${`%report ${id}%`} order by id`;
      expect(events.map((e) => e.event)).toEqual(["task_create_report.failed"]);
    } finally {
      worker.kill(9);
    }
  }, 90_000);

  test("below the limit the same run generates the report", async () => {
    await spend(LIMIT - 1);
    writeFileSync(trace, "");
    const id = await due();
    spawn("worker-b", id);
    await until(() => lines().includes("worker-b webhook"));
    expect(lines().some((l) => l.startsWith("worker-b model report"))).toBe(true);
    expect((await report(id))?.status).toBe("archived");
  }, 90_000);
});
