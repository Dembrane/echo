import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@dembrane/access";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type postgres from "postgres";
import { staffRoutes } from "../src";

// The account page's support access: an organisation's workspaces as staff see them. On a
// fresh database, so it runs wherever TEST_DATABASE_ADMIN_URL is set (staff.integration
// needs the parity template).
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_support_access_${process.pid}`;

const STAFF: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000001",
  directusUserId: "d0000000-0000-4000-8000-000000000001",
  isStaff: true,
};
const ALICE: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000002",
  directusUserId: "d0000000-0000-4000-8000-000000000002",
  isStaff: false,
};

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "warn" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("staff support access on the account page", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const mailer = new MemoryMailer();
    const billing = createBilling({
      db: database.db,
      mollie: new FakeMollie(),
      mailer,
      logger,
      billingConfig: {
        webhookUrl: null,
        forceReconcileFailure: false,
        dashboardUrl: "https://dash.test",
      },
    });
    // The staff member as an app user: the list carries their own visit and request.
    await sql`insert into directus_users (id, email) values (${STAFF.directusUserId}, 'sam@dembrane.com')`;
    await sql`insert into app_user (id, directus_user_id, email, display_name)
      values (${STAFF.appUserId}, ${STAFF.directusUserId}, 'sam@dembrane.com', 'Sam Support')`;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = c.req.header("x-as");
      c.set("requestId", "req-1");
      c.set("principal", who === "staff" ? STAFF : who === "alice" ? ALICE : null);
      await next();
    });
    app.route(
      "/",
      staffRoutes({
        db: database.db,
        staffAudit: new DrizzleStaffAudit(database.db),
        billing,
        mailer,
        logger,
        config: { http: { dashboardUrl: "https://dash.test" } },
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (as: string, path: string) => app.request(path, { headers: { "x-as": as } });

  async function workspace(
    orgId: string,
    name: string,
    o: { support?: boolean; settings?: Record<string, unknown>; deleted?: boolean } = {},
  ) {
    const id = randomUUID();
    const account = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${account}, 'free', ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id, allow_support_access,
        settings, deleted_at)
      values (${id}, ${name}, ${orgId}, ${account}, ${o.support ?? false},
        ${sql.json((o.settings ?? {}) as never)}, ${o.deleted ? new Date().toISOString() : null})`;
    return id;
  }

  test("lists an organisation's live workspaces by name, with their support state", async () => {
    const org = randomUUID();
    const other = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'Gemeente Lindenwijk'), (${other}, 'Elsewhere')`;
    const research = await workspace(org, "Research", { support: true });
    const panels = await workspace(org, "Neighbourhood panels");
    const demo = await workspace(org, "Demo", { settings: { held_for_demo: randomUUID() } });
    await workspace(org, "Archive", { deleted: true });
    await workspace(other, "Not theirs");
    // The caller is on a visit to Research and waits for an answer on Neighbourhood panels.
    const visit = randomUUID();
    const until = new Date(Date.now() + 20 * 3_600_000).toISOString();
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at)
      values (${visit}, ${research}, ${STAFF.appUserId}, 'admin', 'staff_support', ${until})`;
    const request = randomUUID();
    const sent = new Date(Date.now() - 3_600_000).toISOString();
    const expires = new Date(Date.now() + 6 * 86_400_000).toISOString();
    await sql`insert into support_access_request (id, workspace_id, requested_by, status,
        created_at, expires_at)
      values (${request}, ${panels}, ${STAFF.appUserId}, 'pending', ${sent}, ${expires})`;

    const res = await call("staff", `/api/v2/admin/orgs/${org}/workspaces`);
    expect(res.status).toBe(200);
    const none = {
      active: false,
      membership_id: null,
      expires_at: null,
      can_change: false,
      change_until: null,
    };
    const body = (await res.json()) as {
      workspaces: { visit: { expires_at: string | null }; request: unknown }[];
    };
    expect(body).toMatchObject({
      workspaces: [
        {
          workspace_id: demo,
          name: "Demo",
          support_access_enabled: false,
          held_for_demo: true,
          visit: none,
          request: null,
        },
        {
          workspace_id: panels,
          name: "Neighbourhood panels",
          support_access_enabled: false,
          held_for_demo: false,
          visit: none,
          request: { id: request },
        },
        {
          workspace_id: research,
          name: "Research",
          support_access_enabled: true,
          held_for_demo: false,
          visit: { active: true, membership_id: visit, can_change: false, change_until: null },
          request: null,
        },
      ],
    });
    expect(new Date(body.workspaces[2]?.visit.expires_at as string).getTime()).toBe(
      new Date(until).getTime(),
    );
    const req = body.workspaces[1]?.request as { created_at: string; expires_at: string };
    expect(new Date(req.created_at).getTime()).toBe(new Date(sent).getTime());
    expect(new Date(req.expires_at).getTime()).toBe(new Date(expires).getTime());
    // One audited read for the whole list, not one per workspace.
    const reads = await database.db
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.staffUserId, STAFF.directusUserId));
    expect(reads.map((a) => a.action)).toEqual(["org.workspaces.read"]);
    // Audited under the permission that also joins and requests.
    const audit = await database.db
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.action, "org.workspaces.read"));
    expect(audit.map((a) => [a.permission, a.targetId])).toEqual([["staff:support_join", org]]);
  });

  test("an organisation without workspaces has an empty list", async () => {
    const org = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'New')`;
    const res = await call("staff", `/api/v2/admin/orgs/${org}/workspaces`);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  test("only staff read it, and only for an organisation that exists", async () => {
    const org = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'O')`;
    expect((await call("alice", `/api/v2/admin/orgs/${org}/workspaces`)).status).toBe(403);
    expect((await call("staff", `/api/v2/admin/orgs/${randomUUID()}/workspaces`)).status).toBe(404);
    expect((await call("staff", "/api/v2/admin/orgs/not-a-uuid/workspaces")).status).toBe(404);
    await sql`update org set deleted_at = now() where id = ${org}`;
    expect((await call("staff", `/api/v2/admin/orgs/${org}/workspaces`)).status).toBe(404);
  });
});
