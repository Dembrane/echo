import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import postgres from "postgres";
import { failStuckReports, markError, STUCK_REPORT_MS } from "../src/jobs";
import { reportsStorage } from "../src/storage";

// A free draft whose generation ended without markError (a DBOS cancel or timeout) ends in error.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `reports_stuck_drafts_${process.pid}`;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";
const PROJECT = "f0000000-0000-4000-8000-00000000cc01";
const SAMPLE = "f0000000-0000-4000-8000-00000000cc02";
const OCT = "2026-10-01T00:00:00Z";
const NOW = new Date("2026-10-21T12:00:00Z");

run("stuck report drafts", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    await migrate(url, { appEnv: "test" });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    database = createDb({ url, poolMax: 2 });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Stuck', 'en', true, now(), now())`;
    await sql`insert into project (id, name, language, is_conversation_allowed, is_sample, created_at, updated_at)
      values (${SAMPLE}, 'Sample', 'en', true, true, now(), now())`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const old = ago(STUCK_REPORT_MS + 60_000);
  const fresh = ago(STUCK_REPORT_MS - 60_000);

  test("old free drafts end in error and ask for a refund; others are left alone", async () => {
    const rows = await sql`insert into project_report
        (project_id, status, kind, content, date_created, date_updated, deleted_at, free_period_start)
      values
        (${PROJECT}, 'draft', 'report', '', ${old}, null, null, ${OCT}),
        (${PROJECT}, 'draft', 'report', '# Old', ${old}, ${old}, null, ${OCT}),
        (${PROJECT}, 'draft', 'report', '', ${old}, ${fresh}, null, ${OCT}),
        (${PROJECT}, 'draft', 'report', '', ${old}, ${old}, null, null),
        (${PROJECT}, 'archived', 'report', '', ${old}, ${old}, null, ${OCT}),
        (${PROJECT}, 'draft', 'report', '', ${old}, ${old}, ${old}, ${OCT}),
        (${PROJECT}, 'draft', 'deck', '', ${old}, ${old}, null, ${OCT}),
        (${SAMPLE}, 'draft', 'report', '', ${old}, ${old}, null, ${OCT})
      returning id::int`;
    const ids = rows.map((r) => r.id as number);
    const refunded: number[] = [];
    const d = {
      store: reportsStorage(database.db),
      refundFreeReport: async (id: number) => refunded.push(id),
      logger: { error: () => {}, warn: () => {}, info: () => {} } as never,
      now: () => NOW,
    };
    expect(await failStuckReports(d)).toBe(2);
    expect(refunded).toEqual([ids[0], ids[1]] as number[]);
    const after = await sql`select id::int, status, error_code from project_report order by id`;
    const err = { status: "error", error_code: "GENERATION_DID_NOT_FINISH" };
    const left = (status: string) => ({ status, error_code: null });
    expect([...after]).toEqual(
      [
        err,
        err,
        left("draft"),
        left("draft"),
        left("archived"),
        left("draft"),
        left("draft"),
        left("draft"),
      ].map((r, i) => ({ id: ids[i], ...r })),
    );
    expect(await failStuckReports(d)).toBe(0);
    expect(refunded).toHaveLength(2);
  });

  test("a save that lands after the sweep does not archive the report", async () => {
    const store = reportsStorage(database.db);
    const [r] =
      await sql`insert into project_report (project_id, status, kind, content, date_created)
      values (${PROJECT}, 'error', 'report', '', ${old}) returning id::int`;
    expect(await store.archiveDraft(r?.id as number, "# Late", NOW.toISOString())).toBe(false);
    const [row] =
      await sql`select status, content from project_report where id = ${r?.id as number}`;
    expect(row).toEqual({ status: "error", content: "" });
  });

  test("a refund that throws does not stop the sweep", async () => {
    await sql`insert into project_report (project_id, status, kind, content, date_created, free_period_start)
      values (${PROJECT}, 'draft', 'report', '', ${old}, ${OCT}), (${PROJECT}, 'draft', 'report', '', ${old}, ${OCT})`;
    const errors: unknown[] = [];
    const d = {
      store: reportsStorage(database.db),
      refundFreeReport: async () => {
        throw new Error("db down");
      },
      logger: { error: (o: unknown) => errors.push(o), warn: () => {}, info: () => {} } as never,
      now: () => NOW,
    };
    expect(await failStuckReports(d)).toBe(2);
    expect(errors).toHaveLength(2);
  });

  test("a second run neither re-enters nor errors a report another run saved", async () => {
    const store = reportsStorage(database.db);
    const [r] =
      await sql`insert into project_report (project_id, status, kind, content, date_created, free_period_start)
      values (${PROJECT}, 'archived', 'report', '# Saved', ${old}, ${OCT}) returning id::int`;
    const id = r?.id as number;
    expect(await store.startRun(id, NOW.toISOString(), true)).toBe(false);
    expect(await store.startRun(id, NOW.toISOString(), false)).toBe(false);
    const refunded: number[] = [];
    await markError(
      {
        store,
        refundFreeReport: async (n: number) => refunded.push(n),
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        now: () => NOW,
      } as never,
      { projectId: PROJECT, reportId: id, language: "en", userInstructions: "" },
      "GENERATION_FAILED",
      "x",
    );
    const [row] =
      await sql`select status, content, error_code from project_report where id = ${id}`;
    expect(row).toEqual({ status: "archived", content: "# Saved", error_code: null });
    expect(refunded).toEqual([]);
  });

  test("a run starts a scheduled report and a draft", async () => {
    const store = reportsStorage(database.db);
    const rows =
      await sql`insert into project_report (project_id, status, kind, content, date_created)
      values (${PROJECT}, 'scheduled', 'report', '', ${old}), (${PROJECT}, 'draft', 'report', '', ${old})
      returning id::int`;
    const [scheduled, draft] = rows.map((r) => r.id as number) as [number, number];
    expect(await store.startRun(scheduled, NOW.toISOString(), false)).toBe(true);
    expect(await store.startRun(draft, NOW.toISOString(), false)).toBe(true);
    expect(await store.startRun(draft, NOW.toISOString(), true)).toBe(true);
    const after =
      await sql`select status, date_updated from project_report where id in (${scheduled}, ${draft}) order by id`;
    expect(after.map((r) => r.status)).toEqual(["draft", "draft"]);
    expect(after.every((r) => (r.date_updated as Date).getTime() === NOW.getTime())).toBe(true);
  });
});
