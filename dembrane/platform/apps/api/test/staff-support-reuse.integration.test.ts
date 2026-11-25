import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, type AccessStore, DrizzleAccessStore, DrizzleStaffAudit } from "@dembrane/access";
import { ensureUser } from "@dembrane/accounts";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { newId, PlatformError } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { projectRoutes } from "@dembrane/projects";
import { staffRoutes } from "@dembrane/staff";
import { MemoryJobSink, tenancyRoutes } from "@dembrane/tenancy";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";

// An approved support visit that ends must not hand its approval to the next visit. Staff
// get the same membership row back when they join again, so the approval has to end with
// the visit, however it ends. The access rules and the routes are the real ones.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = `staff_support_reuse_${process.pid}`;

run("an approval ends with the support visit it was given to", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>["db"];
  let app: Hono<Env>;
  const byId = new Map<string, Signed>();
  const people = {} as Record<"staff" | "customer", Signed>;
  const ws = { org: newId(), workspace: newId(), billing: newId(), project: newId() };

  const call = async (who: Signed, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "x-as": who.directusUserId, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const rename = (name: string) =>
    call(people.staff, "PATCH", `/api/v2/bff/projects/${ws.project}`, { name });
  const join = () =>
    call(people.staff, "POST", `/api/v2/admin/workspaces/${ws.workspace}/join-support`);
  const leave = () =>
    call(people.staff, "DELETE", `/api/v2/admin/workspaces/${ws.workspace}/join-support`);
  const setSwitch = (on: boolean) =>
    call(people.customer, "PATCH", `/api/v2/workspaces/${ws.workspace}/settings`, {
      allow_support_access: on,
    });
  /** Whether the staff member's visit may change things now, by the rule access applies. */
  const canChange = async () =>
    (
      await (new DrizzleAccessStore(db) as AccessStore).workspaceMembership(
        ws.workspace,
        people.staff.appUserId as string,
        new Date(),
      )
    )?.supportApproved ?? false;
  /** With the switch off, staff ask and the customer approves: a visit that can change. */
  const approvedVisit = async () => {
    const asked = await call(
      people.staff,
      "POST",
      `/api/v2/admin/workspaces/${ws.workspace}/support-access/request`,
      {},
    );
    expect(asked.status).toBe(200);
    const approved = await call(
      people.customer,
      "POST",
      `/api/v2/workspaces/${ws.workspace}/support-access/requests/${asked.data.id}/approve`,
    );
    expect(approved.status).toBe(200);
    expect(await canChange()).toBe(true);
    expect((await rename("Changed while approved")).status).toBe(200);
    const [row] = await db
      .select({ id: schema.workspace_membership.id })
      .from(schema.workspace_membership)
      .where(
        and(
          eq(schema.workspace_membership.workspace_id, ws.workspace),
          eq(schema.workspace_membership.user_id, people.staff.appUserId as string),
        ),
      );
    return row?.id;
  };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    db = database.db;
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "error" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
    const nowIso = new Date().toISOString();
    const role = newId();
    await db.insert(schema.directus_roles).values({ id: role, name: "Administrator" });
    const person = async (email: string, name: string, directusRoleId?: string) => {
      const u = await db.transaction((tx) =>
        ensureUser(tx, {
          email,
          name,
          passwordHash: null,
          nowIso,
          ...(directusRoleId && { directusRoleId }),
        }),
      );
      const p: Signed = {
        appUserId: u.appUserId,
        directusUserId: u.userId,
        isStaff: Boolean(directusRoleId),
      };
      byId.set(p.directusUserId, p);
      return p;
    };
    people.staff = await person("staff@dembrane.example", "Sam Support", role);
    people.customer = await person("pat@riverbend.example", "Pat Rivers");

    await db.insert(schema.org).values({ id: ws.org, name: "Riverbend Housing" });
    await db
      .insert(schema.billing_account)
      .values({ id: ws.billing, org_id: ws.org, tier: "free" });
    await db.insert(schema.org_membership).values({
      id: newId(),
      org_id: ws.org,
      user_id: people.customer.appUserId as string,
      role: "owner",
    });
    await db.insert(schema.workspace).values({
      id: ws.workspace,
      org_id: ws.org,
      name: "Riverbend",
      billing_account_id: ws.billing,
      visibility: "open_to_organisation",
      allow_support_access: false,
    });
    await db.insert(schema.workspace_membership).values({
      id: newId(),
      workspace_id: ws.workspace,
      user_id: people.customer.appUserId as string,
      role: "admin",
      source: "direct",
    });
    await db.insert(schema.project).values({
      id: ws.project,
      name: "Residents evening",
      workspace_id: ws.workspace,
      directus_user_id: people.customer.directusUserId,
      is_conversation_allowed: true,
      visibility: "workspace",
      created_at: nowIso,
      updated_at: nowIso,
    });

    const mailer = new MemoryMailer();
    const dashboardUrl = "https://dashboard.dembrane.example";
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("requestId", "req-test");
      c.set("principal", byId.get(c.req.header("x-as") ?? "") ?? null);
      await next();
    });
    app.route(
      "/",
      tenancyRoutes({
        db,
        accessStore: new DrizzleAccessStore(db),
        jobs: new MemoryJobSink(),
        dashboardUrl,
        inviteSecret: "test-secret",
      }),
    );
    app.route(
      "/",
      projectRoutes({
        db,
        access: new Access(new DrizzleAccessStore(db)),
        queue: { enqueue: async () => null },
      }),
    );
    app.route(
      "/",
      staffRoutes({
        db,
        staffAudit: new DrizzleStaffAudit(db),
        billing: createBilling({
          db,
          mollie: new FakeMollie(),
          mailer,
          logger,
          billingConfig: { webhookUrl: null, forceReconcileFailure: false, dashboardUrl },
        }),
        mailer,
        logger,
        config: { http: { dashboardUrl } },
      }),
    );
    // The API's handler, as apps/api/src/middleware/errors.ts has it.
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  test("the customer turns the switch off and on again: staff come back to read only", async () => {
    const visitRow = await approvedVisit();
    expect((await setSwitch(true)).status).toBe(200);
    // Off ends every visit at once.
    expect((await setSwitch(false)).status).toBe(200);
    expect((await setSwitch(true)).status).toBe(200);
    const back = await join();
    expect(back.status).toBe(200);
    // The same row comes back, without the approval it once had.
    expect(back.data.membership_id).toBe(visitRow);
    expect(await canChange()).toBe(false);
    expect((await rename("Changed after a rejoin")).status).toBe(403);
    await leave();
    await setSwitch(false);
  });

  test("staff leave and join again: they come back to read only", async () => {
    const visitRow = await approvedVisit();
    expect((await leave()).status).toBe(200);
    expect((await setSwitch(true)).status).toBe(200);
    const back = await join();
    expect(back.status).toBe(200);
    expect(back.data.membership_id).toBe(visitRow);
    expect(await canChange()).toBe(false);
    expect((await rename("Changed after leaving")).status).toBe(403);
  });
});
