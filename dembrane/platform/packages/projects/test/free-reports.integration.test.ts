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
import { allowanceForProject, invalidateFreeLimits, usedThisPeriod } from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type postgres from "postgres";
import { refundFreeReport } from "../src/free";
import type { ProjectDeps } from "../src/projects";
import { cancelSchedule, createReport, deleteReport, updateReport } from "../src/reports";
import { projectsStorage } from "../src/storage";

// One free report per period, now or scheduled, given back once when it produced nothing.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_free_reports_${process.pid}`;
const OCT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-21T10:00:00Z";

type Person = Signed & { appUserId: string; directusUserId: string };

run("free reports", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;
  let now: Date;
  let enqueued: unknown[];

  const deps = (over: Partial<ProjectDeps> = {}): ProjectDeps => ({
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
    ...over,
  });

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 12 });
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

  async function seed(tier: string | null = "free") {
    const owner: Person = { appUserId: newId(), directusUserId: newId(), isStaff: false } as Person;
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const [org, billing, ws, own, other, sample] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    for (const [id, isSample] of [
      [own, false],
      [other, false],
      [sample, true],
    ] as const)
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample, directus_user_id)
        values (${id}, 'P', ${ws}, true, ${isSample}, ${owner.directusUserId})`;
    return { owner, billing, own, other, sample };
  }

  const request = (d: ProjectDeps, who: Person, projectId: string, scheduled: string | null) =>
    createReport(d, who, projectId, {
      language: "en",
      user_instructions: null,
      scheduled_at: scheduled,
    });

  const rejection = (p: Promise<unknown>) =>
    Promise.resolve(p).then(
      () => null,
      (e) => e,
    );

  async function ledger(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, now);
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(database.db, a)).reports;
  }

  async function stamp(id: unknown): Promise<string | null> {
    const [row] = await sql`select free_period_start from project_report where id = ${String(id)}`;
    return row?.free_period_start ? (row.free_period_start as Date).toISOString() : null;
  }

  const usageRows = async (billing: string) =>
    Number(
      (await sql`select count(*) as n from free_usage where billing_account_id = ${billing}`)[0]?.n,
    );

  const reportRows = async (projectId: string) =>
    Number(
      (await sql`select count(*) as n from project_report where project_id = ${projectId}`)[0]?.n,
    );

  test("one report per period, now or scheduled", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    expect(await stamp(r.id)).toBe(OCT);
    expect(await rejection(request(d, owner, own, null))).toMatchObject({
      status: 402,
      details: { limit: "report", used: 1, cap: 1 },
    });
    expect(await ledger(own)).toBe(1);
  });

  test("deleting does not refill", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await deleteReport(d, owner, own, Number(r.id));
    expect(await rejection(request(d, owner, own, LATER))).toMatchObject({
      status: 402,
      details: { limit: "report" },
    });
  });

  test("the next period has a fresh report", async () => {
    const { owner, own } = await seed();
    const d = deps();
    await request(d, owner, own, LATER);
    now = new Date("2026-11-02T10:00:00Z");
    const r = await request(d, owner, own, null);
    expect(await stamp(r.id)).toBe("2026-11-01T00:00:00.000Z");
    expect(await ledger(own)).toBe(1);
  });

  test("two report requests race for the last report", async () => {
    const { owner, own, other } = await seed();
    const d = deps();
    const results = await Promise.allSettled([
      request(d, owner, own, LATER),
      request(d, owner, other, LATER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await ledger(own)).toBe(1);
  });

  test("refundFreeReport gives back a report that produced nothing, once", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    const id = Number(r.id);
    await sql`update project_report set status = 'error', content = '' where id = ${id}`;
    expect(await refundFreeReport(database.db, id, now)).toBe(true);
    expect(await ledger(own)).toBe(0);
    expect(await stamp(id)).toBeNull();
    expect(await refundFreeReport(database.db, id, now)).toBe(false);
    expect(await ledger(own)).toBe(0);

    const done = await request(d, owner, own, LATER);
    await sql`update project_report set status = 'archived', content = '# Done' where id = ${String(done.id)}`;
    expect(await refundFreeReport(database.db, Number(done.id), now)).toBe(false);
    expect(await ledger(own)).toBe(1);
  });

  test("a report from another period clears its stamp and gives nothing back", async () => {
    const { owner, own } = await seed();
    const r = await request(deps(), owner, own, LATER);
    await sql`update project_report set status = 'error', content = '', free_period_start = '2026-09-01T00:00:00Z' where id = ${String(r.id)}`;
    expect(await refundFreeReport(database.db, Number(r.id), now)).toBe(false);
    expect(await stamp(r.id)).toBeNull();
    expect(await ledger(own)).toBe(1);
  });

  test("a failed insert gives the report back", async () => {
    const { owner, own } = await seed();
    const d = deps({
      jobs: {
        enqueue: async () => {
          throw new Error("queue down");
        },
      } as ProjectDeps["jobs"],
    });
    expect(await rejection(request(d, owner, own, null))).toMatchObject({ message: "queue down" });
    expect(await ledger(own)).toBe(0);
    expect(await reportRows(own)).toBe(0);
  });

  test("paid and legacy projects are not counted", async () => {
    for (const tier of ["guardian", "pioneer"]) {
      const { owner, billing, own } = await seed(tier);
      const r = await request(deps(), owner, own, LATER);
      await request(deps(), owner, own, LATER);
      expect(await stamp(r.id)).toBeNull();
      expect(await usageRows(billing)).toBe(0);
    }
    const { owner, billing, own } = await seed();
    await sql`update project set workspace_id = null where id = ${own}`;
    const r = await request(deps(), owner, own, LATER);
    expect(await stamp(r.id)).toBeNull();
    expect(await usageRows(billing)).toBe(0);
  });

  test("the sample keeps its own report", async () => {
    const { owner, billing, sample, own } = await seed();
    const d = deps();
    const r = await request(d, owner, sample, LATER);
    expect(await stamp(r.id)).toBeNull();
    expect(await usageRows(billing)).toBe(0);
    expect(await rejection(request(d, owner, sample, LATER))).toMatchObject({
      status: 402,
      details: { limit: "report" },
    });
    // The workspace's own report is still there.
    await request(d, owner, own, LATER);
    expect(await ledger(own)).toBe(1);
  });
  const reschedule = (
    d: ProjectDeps,
    who: Person,
    projectId: string,
    id: unknown,
    body: { status?: string | null; scheduled_at?: string | null },
  ) =>
    updateReport(d, who, projectId, Number(id), {
      status: body.status ?? null,
      show_portal_link: null,
      content: null,
      scheduled_at: body.scheduled_at ?? null,
    });

  const LATER2 = "2026-10-22T10:00:00Z";

  async function refunded(d: ProjectDeps, who: Person, projectId: string) {
    const r = await request(d, who, projectId, LATER);
    await sql`update project_report set status = 'error', content = '' where id = ${String(r.id)}`;
    expect(await refundFreeReport(database.db, Number(r.id), now)).toBe(true);
    return r;
  }

  test("rescheduling a refunded report takes the period's report again", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await refunded(d, owner, own);
    expect(await ledger(own)).toBe(0);
    await reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 });
    expect(await ledger(own)).toBe(1);
    expect(await stamp(r.id)).toBe(OCT);
  });

  test("rescheduling a refunded report is refused when the period's report is spent", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await refunded(d, owner, own);
    await request(d, owner, own, LATER);
    for (const body of [{ status: "scheduled", scheduled_at: LATER2 }, { status: "scheduled" }])
      expect(await rejection(reschedule(d, owner, own, r.id, body))).toMatchObject({
        status: 402,
        details: { limit: "report", used: 1, cap: 1 },
      });
    const [row] = await sql`select status from project_report where id = ${String(r.id)}`;
    expect(row?.status).toBe("error");
    expect(await stamp(r.id)).toBeNull();
    expect(await ledger(own)).toBe(1);
  });

  test("rescheduling a report that already produced content takes again", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await sql`update project_report set status = 'archived', content = '# Done' where id = ${String(r.id)}`;
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({
      status: 402,
      details: { limit: "report" },
    });
  });

  test("moving a stamped report that has not run does not take twice", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 });
    await reschedule(d, owner, own, r.id, { scheduled_at: LATER });
    expect(await ledger(own)).toBe(1);
    expect(await stamp(r.id)).toBe(OCT);
  });

  test("two reschedules of a refunded report race and take once", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await refunded(d, owner, own);
    await Promise.all([
      reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER }),
    ]);
    expect(await ledger(own)).toBe(1);
  });

  test("a failed reschedule gives the report back", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await refunded(d, owner, own);
    const broken = deps({
      store: {
        ...projectsStorage(database.db),
        transaction: async () => {
          throw new Error("db down");
        },
      } as ProjectDeps["store"],
    });
    expect(
      await rejection(
        reschedule(broken, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ message: "db down" });
    expect(await ledger(own)).toBe(0);
    expect(await stamp(r.id)).toBeNull();
    const [row] = await sql`select status from project_report where id = ${String(r.id)}`;
    expect(row?.status).toBe("error");
  });

  test("paid and sample reschedules are not counted", async () => {
    const { owner, billing, own } = await seed("guardian");
    const r = await request(deps(), owner, own, LATER);
    await sql`update project_report set status = 'error' where id = ${String(r.id)}`;
    await reschedule(deps(), owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 });
    expect(await stamp(r.id)).toBeNull();
    expect(await usageRows(billing)).toBe(0);

    const free = await seed();
    const s = await request(deps(), free.owner, free.sample, LATER);
    await sql`update project_report set status = 'error' where id = ${String(s.id)}`;
    await reschedule(deps(), free.owner, free.sample, s.id, {
      status: "scheduled",
      scheduled_at: LATER2,
    });
    expect(await stamp(s.id)).toBeNull();
    expect(await usageRows(free.billing)).toBe(0);
  });
  test("clearing a report's content does not make its regeneration free", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await sql`update project_report set status = 'archived', content = '# Done' where id = ${String(r.id)}`;
    await updateReport(d, owner, own, Number(r.id), {
      status: null,
      show_portal_link: null,
      content: "",
      scheduled_at: null,
    });
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ status: 402, details: { limit: "report" } });
    // Moving a report that ran back to cancelled does not make it unrun.
    await reschedule(d, owner, own, r.id, { status: "cancelled" });
    expect(await stamp(r.id)).toBeNull();
    expect(await ledger(own)).toBe(1);
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ status: 402, details: { limit: "report" } });
    expect(await ledger(own)).toBe(1);
  });

  test("a regeneration that errors is refunded once, though the old content stays", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await sql`update project_report set status = 'archived', content = '# Done' where id = ${String(r.id)}`;
    now = new Date("2026-11-02T10:00:00Z");
    await reschedule(d, owner, own, r.id, {
      status: "scheduled",
      scheduled_at: "2026-11-03T10:00:00Z",
    });
    expect(await ledger(own)).toBe(1);
    await sql`update project_report set status = 'error' where id = ${String(r.id)}`;
    expect(await refundFreeReport(database.db, Number(r.id), now)).toBe(true);
    expect(await refundFreeReport(database.db, Number(r.id), now)).toBe(false);
    expect(await ledger(own)).toBe(0);
  });

  test("an edit without status or schedule never charges", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await sql`update project_report set free_period_start = '2026-09-01T00:00:00Z' where id = ${String(r.id)}`;
    await sql`delete from free_usage`;
    await updateReport(d, owner, own, Number(r.id), {
      status: null,
      show_portal_link: true,
      content: null,
      scheduled_at: null,
    });
    expect(await ledger(own)).toBe(0);
  });

  test("rescheduling a free report while it generates is refused and starts no second run", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, null);
    expect(enqueued).toHaveLength(1);
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ status: 409, code: "report.already_generating" });
    const [row] = await sql`select status from project_report where id = ${String(r.id)}`;
    expect(row?.status).toBe("draft");
    const tasks =
      await sql`select 1 from scheduled_task where payload->>'report_id' = ${String(r.id)}`;
    expect(tasks).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(await ledger(own)).toBe(1);
  });

  test("cancelling a running draft counts as having run", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, null);
    await reschedule(d, owner, own, r.id, { status: "cancelled" });
    expect(await stamp(r.id)).toBeNull();
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ status: 402, details: { limit: "report" } });
    now = new Date("2026-11-02T10:00:00Z");
    await reschedule(d, owner, own, r.id, {
      status: "scheduled",
      scheduled_at: "2026-11-03T10:00:00Z",
    });
    expect(await ledger(own)).toBe(1);
    expect(await stamp(r.id)).toBe("2026-11-01T00:00:00.000Z");
  });

  test("cancelling a report before it ran gives it back once; rescheduling takes again", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await reschedule(d, owner, own, r.id, { status: "cancelled" });
    expect(await stamp(r.id)).toBeNull();
    expect(await ledger(own)).toBe(0);
    await reschedule(d, owner, own, r.id, { status: "cancelled" });
    expect(await ledger(own)).toBe(0);
    await reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 });
    expect(await ledger(own)).toBe(1);
    expect(await stamp(r.id)).toBe(OCT);
  });

  test("cancel schedule gives the report back once, so generate now works", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, LATER);
    await cancelSchedule(d, owner, own, Number(r.id));
    expect(await ledger(own)).toBe(0);
    // A retry heals and does not refund twice.
    expect(await cancelSchedule(d, owner, own, Number(r.id))).toEqual({ cancelled: true });
    expect(await ledger(own)).toBe(0);
    const now2 = await request(d, owner, own, null);
    expect(await stamp(now2.id)).toBe(OCT);
    expect(await ledger(own)).toBe(1);
    expect(
      await rejection(
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ),
    ).toMatchObject({ status: 402, details: { limit: "report" } });
  });

  test("paid cancels touch no ledger", async () => {
    const { owner, billing, own } = await seed("guardian");
    const r = await request(deps(), owner, own, LATER);
    await cancelSchedule(deps(), owner, own, Number(r.id));
    expect(await usageRows(billing)).toBe(0);
  });

  test("cancel schedule of a report that is not scheduled is refused", async () => {
    const { owner, own } = await seed();
    const d = deps();
    const r = await request(d, owner, own, null);
    expect(await rejection(cancelSchedule(d, owner, own, Number(r.id)))).toMatchObject({
      status: 400,
    });
    expect(await ledger(own)).toBe(1);
  });

  test("a cancel racing a reschedule never leaves an unpaid scheduled report", async () => {
    for (let i = 0; i < 8; i++) {
      const { owner, own } = await seed();
      const d = deps();
      const r = await request(d, owner, own, LATER);
      const cancel =
        i % 2
          ? cancelSchedule(d, owner, own, Number(r.id))
          : reschedule(d, owner, own, r.id, { status: "cancelled" });
      const results = await Promise.allSettled([
        cancel,
        reschedule(d, owner, own, r.id, { status: "scheduled", scheduled_at: LATER2 }),
      ]);
      for (const x of results)
        if (x.status === "rejected") expect(x.reason).toMatchObject({ status: 402 });
      const [row] = await sql`select status from project_report where id = ${String(r.id)}`;
      const paid = { stamp: await stamp(r.id), used: await ledger(own) };
      if (row?.status === "scheduled") expect(paid).toEqual({ stamp: OCT, used: 1 });
      else expect(paid).toEqual({ stamp: null, used: 0 });
    }
  });

  test("a PATCH cancel that lands after the run started counts as having run", async () => {
    const { owner, own } = await seed();
    const r = await request(deps(), owner, own, LATER);
    const store = projectsStorage(database.db);
    let started = false;
    // The scheduler starts the run between the cancel's charge and its update.
    const d = deps({
      store: {
        ...store,
        transaction: async (fn: never) => {
          if (!started) {
            started = true;
            await sql`update project_report set status = 'draft' where id = ${String(r.id)}`;
          }
          return store.transaction(fn);
        },
      } as ProjectDeps["store"],
    });
    await reschedule(d, owner, own, r.id, { status: "cancelled" });
    const [row] = await sql`select status from project_report where id = ${String(r.id)}`;
    expect(row?.status).toBe("cancelled");
    expect(await stamp(r.id)).toBeNull();
    expect(await ledger(own)).toBe(1);
  });
});
