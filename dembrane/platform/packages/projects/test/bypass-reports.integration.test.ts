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
import { failStuckReports, STUCK_REPORT_MS } from "../../reports/src/jobs";
import { reportsStorage } from "../../reports/src/storage";
import { refundFreeReport } from "../src/free";
import type { ProjectDeps } from "../src/projects";
import { cancelSchedule, createReport, updateReport } from "../src/reports";
import { projectsStorage } from "../src/storage";

// Adversarial review (group D): paths that let a free account generate more reports than its 1.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_bypass_reports_${process.pid}`;

type Person = Signed & { appUserId: string; directusUserId: string };

run("report bypasses", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;
  let now: Date;

  const deps = (): ProjectDeps => ({
    db: database.db,
    store: projectsStorage(database.db),
    access,
    jobs: { enqueue: async () => "job" } as unknown as ProjectDeps["jobs"],
    now: () => now,
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
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function person(): Promise<Person> {
    const p = { appUserId: newId(), directusUserId: newId(), isStaff: false } as Person;
    await sql`insert into directus_users (id) values (${p.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${p.appUserId}, ${p.directusUserId})`;
    return p;
  }

  async function project(ws: string, owner: Person) {
    const id = newId();
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${newId()}, ${ws}, ${owner.appUserId}, 'owner') on conflict do nothing`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, directus_user_id)
      values (${id}, 'P', ${ws}, true, ${owner.directusUserId})`;
    return id;
  }

  const request = (who: Person, projectId: string, scheduled: string | null) =>
    createReport(deps(), who, projectId, {
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

  // BYPASS D-R1: a stamp keeps only the period, so a report charged to the org's pooled free
  // account is refunded into the client workspace's own free account once the org upgrades.
  test("a report charged to the org pool is not refunded into the client's own account", async () => {
    const owner = await person();
    const [org, orgAccount, orgWs, clientAccount, clientWs] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier, created_at)
      values (${orgAccount}, ${org}, 'free', '2026-01-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${orgWs}, 'Org W', ${org}, ${orgAccount})`;
    await sql`insert into billing_account (id, org_id, tier, created_at)
      values (${clientAccount}, null, 'free', '2026-02-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${clientWs}, 'Client W', ${org}, ${clientAccount})`;
    const p = await project(clientWs, owner);

    // Pooled: the scheduled report takes the org's report.
    expect((await allowanceForProject(database.db, p, now))?.accountId).toBe(orgAccount);
    const scheduled = (await request(owner, p, "2026-10-27T10:00:00Z")) as { id: unknown };
    expect(await ledger(p)).toBe(1);

    // The org upgrades mid-month: the client now counts against its own free account.
    await sql`update billing_account set tier = 'changemaker' where id = ${orgAccount}`;
    expect((await allowanceForProject(database.db, p, now))?.accountId).toBe(clientAccount);
    await request(owner, p, null);
    expect(await ledger(p)).toBe(1);

    // Cancelling the pooled report must not credit the client's own account.
    await cancelSchedule(deps(), owner, p, Number(scheduled.id));
    expect(await ledger(p)).toBe(1);
    await sql`update project_report set status = 'archived' where project_id = ${p} and status = 'draft'`;
    const third = await rejection(request(owner, p, null));
    expect(third).toMatchObject({ status: 402 });
  });

  test("an errored pooled report is not refunded into the client's own account", async () => {
    const owner = await person();
    const [org, orgAccount, orgWs, clientAccount, clientWs] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier, created_at)
      values (${orgAccount}, ${org}, 'free', '2026-01-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${orgWs}, 'Org W', ${org}, ${orgAccount})`;
    await sql`insert into billing_account (id, org_id, tier, created_at)
      values (${clientAccount}, null, 'free', '2026-02-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${clientWs}, 'Client W', ${org}, ${clientAccount})`;
    const p = await project(clientWs, owner);
    const pooled = (await request(owner, p, "2026-10-27T10:00:00Z")) as { id: unknown };
    const [row] =
      await sql`select free_account_id from project_report where id = ${String(pooled.id)}`;
    expect(row?.free_account_id).toBe(orgAccount);

    await sql`update billing_account set tier = 'changemaker' where id = ${orgAccount}`;
    await request(owner, p, null);
    expect(await ledger(p)).toBe(1);
    await sql`update project_report set status = 'error' where id = ${String(pooled.id)}`;
    expect(await refundFreeReport(database.db, Number(pooled.id), now)).toBe(false);
    expect(await ledger(p)).toBe(1);
    const [after] =
      await sql`select free_period_start, free_account_id from project_report where id = ${String(pooled.id)}`;
    expect(after).toEqual({ free_period_start: null, free_account_id: null });
  });

  // BYPASS D-R2 (precondition: a run still alive past the sweep, e.g. one DBOS recovery resumed
  // with a fresh deadline): the sweep refunds the draft, a PATCH back to draft is free, and the
  // surviving run's conditional save then archives content on a refunded report.
  test("a swept and refunded draft moved back to draft cannot be saved by its old run", async () => {
    const owner = await person();
    const [org, account, ws] = [newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${account}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${account})`;
    const p = await project(ws, owner);
    const created = (await request(owner, p, null)) as { id: unknown };
    const id = Number(created.id);
    expect(await ledger(p)).toBe(1);

    // The run started (guard), then went quiet past the sweep's cutoff.
    const started = new Date(now.getTime() - STUCK_REPORT_MS - 60_000).toISOString();
    await sql`update project_report set date_updated = ${started} where id = ${id}`;
    const store = reportsStorage(database.db);
    const swept = await failStuckReports({
      store,
      refundFreeReport: (rid: number) => refundFreeReport(database.db, rid, now),
      logger: { error() {}, warn() {}, info() {} } as never,
      now: () => now,
    });
    expect(swept).toBe(1);
    expect(await ledger(p)).toBe(0);

    // API-only: error back to draft charges nothing (a fix may refuse it instead).
    await rejection(
      updateReport(deps(), owner, p, id, {
        status: "draft",
        show_portal_link: null,
        content: null,
        scheduled_at: null,
      }),
    );
    // The surviving run's save step.
    const saved = await store.archiveDraft(id, "# Generated", now.toISOString());
    const [row] = await sql`select status, content from project_report where id = ${id}`;
    const charged = await ledger(p);
    // Either the old run cannot save, or the content it saves is charged.
    expect(saved ? { content: row?.content, charged } : "not saved").toEqual(
      saved ? { content: "# Generated", charged: 1 } : "not saved",
    );
  });
});
