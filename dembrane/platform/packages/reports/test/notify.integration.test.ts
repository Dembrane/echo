import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import postgres from "postgres";
import { emailReportSubscribers } from "../src/notify";
import { reportsStorage } from "../src/storage";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/reports_notify_test` : "";
const PROJECT = "f0000000-0000-4000-8000-00000000cc01";
const OTHER = "f0000000-0000-4000-8000-00000000cc02";
const CONVERSATION = "c0000000-0000-4000-8000-00000000cc01";
const sub = (n: number) => `f7000000-0000-4000-8000-0000000000${n.toString().padStart(2, "0")}`;
const token = (n: number) => `e7000000-0000-4000-8000-0000000000${n.toString().padStart(2, "0")}`;

run("emailing a published report's subscribers", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  const enqueued: { name: string; payload: unknown; workflowId?: string | undefined }[] = [];
  const deps = () => ({
    store: reportsStorage(database.db),
    portalUrl: "https://portal.example",
    jobs: {
      enqueue: async (def: { name: string }, payload: unknown, opts?: { workflowId?: string }) => {
        enqueued.push({ name: def.name, payload, workflowId: opts?.workflowId });
      },
    },
  });

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists reports_notify_test with (force)");
    await a.unsafe("create database reports_notify_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    database = createDb({ url, poolMax: 2 });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Notify', 'nl', true, now(), now()), (${OTHER}, 'Other', 'en', true, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${CONVERSATION}, ${PROJECT}, 'Resident 1', now(), now())`;
    // 1: published, 2: archived.
    await sql`insert into project_report (project_id, status, language, kind, content, date_created)
      values (${PROJECT}, 'published', 'nl', 'report', '# R', now()),
             (${PROJECT}, 'archived', 'nl', 'report', '# Old', now())`;
    // 1: opted in from a conversation, 2: opted out, 3: opted in with no token yet,
    // 4: another project's subscriber.
    await sql`insert into project_report_notification_participants (id, project_id, email, email_opt_in, email_opt_out_token, conversation_id)
      values (${sub(1)}, ${PROJECT}, 'a@example.com', true, ${token(1)}, ${CONVERSATION}),
             (${sub(2)}, ${PROJECT}, 'b@example.com', false, ${token(2)}, ${CONVERSATION}),
             (${sub(3)}, ${PROJECT}, 'c@example.com', true, null, null),
             (${sub(4)}, ${OTHER}, 'd@example.com', true, ${token(4)}, null)`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  test("each opted-in subscriber of the project gets one email in the report's language", async () => {
    const n = await emailReportSubscribers(deps(), { projectId: PROJECT, reportId: 1 }, "run-1");
    expect(n).toBe(2);
    const [c] =
      await sql`select email_opt_out_token::text as token from project_report_notification_participants where id = ${sub(3)}`;
    // A subscriber without an unsubscribe token gets one, so the email's link works.
    expect(c?.token).toMatch(/^[0-9a-f-]{36}$/);
    const email = (to: string, tok: string, name: string) => ({
      to,
      subject: "A report featuring your input is ready",
      template: "report_published",
      data: {
        portal_url: "https://portal.example",
        project_id: PROJECT,
        token: tok,
        conversation_name: name,
      },
      context: "report 1 published",
      language: "nl",
    });
    expect(enqueued).toEqual([
      {
        name: "account.send-email",
        payload: email("a@example.com", token(1), "Resident 1"),
        workflowId: `run-1:${sub(1)}`,
      },
      {
        name: "account.send-email",
        payload: email("c@example.com", c?.token as string, ""),
        workflowId: `run-1:${sub(3)}`,
      },
    ]);
  });

  test("a report no longer published by the time the job runs emails nobody", async () => {
    enqueued.length = 0;
    expect(await emailReportSubscribers(deps(), { projectId: PROJECT, reportId: 2 }, "run-2")).toBe(
      0,
    );
    await sql`update project_report set deleted_at = now() where id = 1`;
    expect(await emailReportSubscribers(deps(), { projectId: PROJECT, reportId: 1 }, "run-3")).toBe(
      0,
    );
    expect(enqueued).toEqual([]);
  });
  test("each address follows its latest choice across duplicate rows, and a canvas emails nobody", async () => {
    const dup = "f0000000-0000-4000-8000-00000000cc03";
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${dup}, 'Duplicates', 'en', true, now(), now())`;
    // 3: the published report, 4: a published canvas.
    await sql`insert into project_report (project_id, status, language, kind, content, date_created)
      values (${dup}, 'published', 'en', 'report', '# R', now()),
             (${dup}, 'published', 'en', 'canvas', '', now())`;
    // e: an old mixed-case row still opted in, then unsubscribed through a newer row.
    // f: unsubscribed once, then signed up again.
    await sql`insert into project_report_notification_participants (id, project_id, email, email_opt_in, email_opt_out_token, date_submitted, date_updated)
      values (${sub(11)}, ${dup}, 'E@example.com', true, ${token(11)}, '2026-01-01', null),
             (${sub(12)}, ${dup}, 'e@example.com', false, ${token(12)}, '2026-02-01', '2026-03-01'),
             (${sub(13)}, ${dup}, 'f@example.com', false, ${token(13)}, '2026-01-01', '2026-02-01'),
             (${sub(14)}, ${dup}, 'f@example.com', true, ${token(14)}, '2026-03-01', null)`;
    enqueued.length = 0;
    expect(await emailReportSubscribers(deps(), { projectId: dup, reportId: 4 }, "run-4")).toBe(0);
    expect(await emailReportSubscribers(deps(), { projectId: dup, reportId: 3 }, "run-5")).toBe(1);
    expect(enqueued.map((e) => [(e.payload as { to: string }).to, e.workflowId])).toEqual([
      ["f@example.com", `run-5:${sub(14)}`],
    ]);
  });
});
