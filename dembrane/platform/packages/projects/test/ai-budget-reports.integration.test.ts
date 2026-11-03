import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AI_SPEND_KEY, invalidateFreeLimits } from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type postgres from "postgres";
import type { ProjectDeps } from "../src/projects";
import { cancelSchedule, createReport, deleteReport, updateReport } from "../src/reports";
import { projectsStorage } from "../src/storage";

// A free account starts a report while its AI budget lasts; nothing is counted or refunded.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_ai_budget_reports_${process.pid}`;
const OCT = "2026-10-01T00:00:00Z";
const LATER = "2026-10-21T10:00:00Z";
const LATER2 = "2026-10-22T10:00:00Z";
const LIMIT = 5_000_000;

type Person = Signed & { appUserId: string; directusUserId: string };

run("reports and the AI budget", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;
  let now: Date;
  let enqueued: unknown[];

  const deps = (): ProjectDeps => ({
    db: database.db,
    store: projectsStorage(database.db),
    access,
    jobs: {
      enqueue: async (_def: unknown, payload: unknown) => {
        enqueued.push(payload);
        return "job";
      },
    } as ProjectDeps["jobs"],
    now: () => now,
  });

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 8 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    access = new Access(new DrizzleAccessStore(database.db));
  });

  beforeEach(() => {
    invalidateFreeLimits();
    now = new Date("2026-10-20T10:00:00Z");
    enqueued = [];
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function seed(tier = "free") {
    const owner = { appUserId: newId(), directusUserId: newId(), isStaff: false } as Person;
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const [org, billing, ws, own, sample] = [newId(), newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    for (const [id, isSample] of [
      [own, false],
      [sample, true],
    ] as const)
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample, directus_user_id)
        values (${id}, 'P', ${ws}, true, ${isSample}, ${owner.directusUserId})`;
    return { owner, billing, own, sample };
  }

  async function spend(billing: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${OCT}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  const ledger = async (billing: string) =>
    [
      ...(await sql`select key, amount::text from free_usage
        where billing_account_id = ${billing} order by key`),
    ].map((r) => `${r.key}=${r.amount}`);

  const request = (who: Person, projectId: string, scheduled: string | null) =>
    createReport(deps(), who, projectId, {
      language: "en",
      user_instructions: null,
      scheduled_at: scheduled,
    });

  const patch = (
    who: Person,
    projectId: string,
    id: unknown,
    body: { status?: string | null; scheduled_at?: string | null },
  ) =>
    updateReport(deps(), who, projectId, Number(id), {
      status: body.status ?? null,
      show_portal_link: null,
      content: null,
      scheduled_at: body.scheduled_at ?? null,
    });

  const rejection = (p: Promise<unknown>) =>
    Promise.resolve(p).then(
      () => null,
      (e) => e,
    );

  const reportRows = async (projectId: string) =>
    Number(
      (await sql`select count(*) as n from project_report where project_id = ${projectId}`)[0]?.n,
    );

  async function row(id: unknown) {
    const [r] = await sql`select status, free_period_start, free_account_id, deleted_at
      from project_report where id = ${String(id)}`;
    return r;
  }

  test("at zero, creating a report now or scheduled is refused and writes nothing", async () => {
    const { owner, billing, own } = await seed();
    await spend(billing, LIMIT);
    for (const scheduled of [null, LATER]) {
      const err = await rejection(request(owner, own, scheduled));
      expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget", percent: 100 } });
      expect(err.details).not.toHaveProperty("used");
      expect(err.details).not.toHaveProperty("cap");
    }
    expect(await reportRows(own)).toBe(0);
    expect(enqueued).toEqual([]);
    const tasks = await sql`select id from scheduled_task where payload->>'project_id' = ${own}`;
    expect(tasks).toHaveLength(0);
  });

  test("below the limit, reports start unstamped and count nothing, as many as asked", async () => {
    const { owner, billing, own } = await seed();
    await spend(billing, LIMIT - 1);
    const first = await request(owner, own, LATER);
    const second = await request(owner, own, LATER2);
    const third = await request(owner, own, null);
    for (const r of [first, second, third])
      expect(await row(r.id)).toMatchObject({ free_period_start: null, free_account_id: null });
    expect(await ledger(billing)).toEqual([`${AI_SPEND_KEY}=${LIMIT - 1}`]);
    expect(enqueued).toHaveLength(1);
  });

  test("paid accounts never refuse for budget", async () => {
    const { owner, billing, own } = await seed("guardian");
    await spend(billing, LIMIT * 2);
    const r = await request(owner, own, null);
    expect(await row(r.id)).toMatchObject({ status: "draft", free_period_start: null });
  });

  test("a free sample keeps one report and never refuses for budget", async () => {
    const { owner, billing, sample } = await seed();
    await spend(billing, LIMIT);
    await request(owner, sample, LATER);
    expect(await rejection(request(owner, sample, LATER))).toMatchObject({
      status: 402,
      details: { limit: "report" },
    });
  });

  test("cancelling, rescheduling and deleting a scheduled report change no ledger row", async () => {
    const { owner, billing, own } = await seed();
    await spend(billing, 1_000);
    const before = await ledger(billing);
    const r = await request(owner, own, LATER);
    await cancelSchedule(deps(), owner, own, Number(r.id));
    expect(await row(r.id)).toMatchObject({ status: "cancelled", free_period_start: null });
    // A retry of a cancel that already happened heals.
    expect(await cancelSchedule(deps(), owner, own, Number(r.id))).toEqual({ cancelled: true });
    await patch(owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 });
    expect(await row(r.id)).toMatchObject({ status: "scheduled", free_period_start: null });
    await patch(owner, own, r.id, { status: "cancelled" });
    await patch(owner, own, r.id, { status: "scheduled", scheduled_at: LATER });
    await deleteReport(deps(), owner, own, Number(r.id));
    expect((await row(r.id))?.deleted_at).not.toBeNull();
    const tasks =
      await sql`select status from scheduled_task where payload->>'report_id' = ${String(r.id)}`;
    expect(tasks.every((t) => t.status === "cancelled")).toBe(true);
    expect(await ledger(billing)).toEqual(before);
  });

  test("cancel schedule of a report that is not scheduled is refused", async () => {
    const { owner, own } = await seed();
    const r = await request(owner, own, null);
    expect(await rejection(cancelSchedule(deps(), owner, own, Number(r.id)))).toMatchObject({
      status: 400,
    });
    expect((await row(r.id))?.status).toBe("draft");
  });
});
