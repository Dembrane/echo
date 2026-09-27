import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@echo/db";
import postgres from "postgres";
import { backfillScheduled, runScheduledReports } from "../src/jobs";
import { reportsStorage } from "../src/storage";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/reports_scheduled_test` : "";
const PROJECT = "f0000000-0000-4000-8000-00000000bb01";
const TASK = "f6000000-0000-4000-8000-00000000bb01";

run("the scheduled report runner", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists reports_scheduled_test with (force)");
    await a.unsafe("create database reports_scheduled_test");
    await a.end();
    await migrate(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    database = createDb({ url, poolMax: 2 });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Scheduled', 'nl', true, now(), now())`;
    // 1: due and scheduled, 2: due but cancelled meanwhile, 3: scheduled with no task row.
    await sql`insert into project_report (project_id, status, language, kind, content, date_created, scheduled_at, user_instructions)
      values (${PROJECT}, 'scheduled', 'nl', 'report', '', now(), now() - interval '1 minute', 'Kort'),
             (${PROJECT}, 'cancelled', 'nl', 'report', '', now(), now() - interval '1 minute', null),
             (${PROJECT}, 'scheduled', null, 'report', '', now(), now() + interval '1 day', null)`;
    await sql`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
      values (${TASK}, 'generate_report', ${{ report_id: 1, project_id: PROJECT, language: "nl", user_instructions: "Kort" } as never}, now() - interval '1 minute', 'scheduled', 0, now(), now()),
             ('f6000000-0000-4000-8000-00000000bb02', 'generate_report', ${{ report_id: "2", project_id: PROJECT } as never}, now() - interval '1 minute', 'scheduled', 0, now(), now()),
             ('f6000000-0000-4000-8000-00000000bb03', 'generate_report', ${{ project_id: PROJECT } as never}, now() - interval '1 minute', 'scheduled', 0, now(), now())`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  test("a due report moves to draft and its generation is enqueued in the same transaction", async () => {
    const enqueued: unknown[] = [];
    const n = await runScheduledReports({
      store: reportsStorage(database.db),
      jobs: {
        enqueue: async (def, payload, opts) => {
          enqueued.push({ name: def.name, payload, inTx: Boolean(opts?.tx) });
        },
      },
    });
    expect(n).toBe(3);
    expect(enqueued).toEqual([
      {
        name: "reports.generate",
        payload: { projectId: PROJECT, reportId: 1, language: "nl", userInstructions: "Kort" },
        inTx: true,
      },
    ]);
    const reports = await sql`select id::int, status from project_report order by id`;
    expect([...reports]).toEqual([
      { id: 1, status: "draft" },
      { id: 2, status: "cancelled" },
      { id: 3, status: "scheduled" },
    ]);
    const tasks = await sql`select status, error, attempts from scheduled_task order by id`;
    expect([...tasks]).toEqual([
      { status: "completed", error: null, attempts: 1 },
      { status: "completed", error: null, attempts: 1 },
      {
        status: "failed",
        error: "generate_report payload missing report_id/project_id",
        attempts: 1,
      },
    ]);
  });

  test("a still-scheduled report without a task row gets one; a covered one does not", async () => {
    expect(await backfillScheduled({ store: reportsStorage(database.db) })).toBe(1);
    expect(await backfillScheduled({ store: reportsStorage(database.db) })).toBe(0);
    const [row] = await sql`select payload, status from scheduled_task
      where status = 'scheduled' and task_type = 'generate_report'`;
    expect(row).toEqual({
      payload: { report_id: 3, project_id: PROJECT, language: "en", user_instructions: "" },
      status: "scheduled",
    });
  });
});
