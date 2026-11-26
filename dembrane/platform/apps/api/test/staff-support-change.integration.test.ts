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
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";

// Staff on a read-only visit ask for more, and the customer's approval lets the same person
// make changes for 24 hours. The access rules, the staff routes and the customer's approve
// route are the real ones.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = `staff_support_change_${process.pid}`;
const DAY_MS = 86_400_000;

run("staff ask to make changes while support access is on", () => {
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
  const visit = () =>
    call(people.staff, "GET", `/api/v2/admin/workspaces/${ws.workspace}/join-support`);

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
    // The customer has turned support access on themselves.
    await db.insert(schema.workspace).values({
      id: ws.workspace,
      org_id: ws.org,
      name: "Riverbend",
      billing_account_id: ws.billing,
      visibility: "open_to_organisation",
      allow_support_access: true,
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

  test("joined to read, asked, approved: the same visit can change a project until 24 hours after the approval", async () => {
    // Joined while the switch is on: read only.
    const joined = await call(
      people.staff,
      "POST",
      `/api/v2/admin/workspaces/${ws.workspace}/join-support`,
    );
    expect(joined.status).toBe(200);
    expect(joined.data.status).toBe("joined");
    expect((await visit()).data).toMatchObject({ active: true, can_change: false });
    expect((await rename("Changed by staff")).status).toBe(403);

    // Asking is no longer refused while the switch is on.
    const asked = await call(
      people.staff,
      "POST",
      `/api/v2/admin/workspaces/${ws.workspace}/support-access/request`,
      { message: "The portal link in your report is broken; I would like to fix it." },
    );
    expect(asked.status).toBe(200);
    expect(asked.data.status).toBe("pending");

    // The customer approves it from their workspace.
    const approved = await call(
      people.customer,
      "POST",
      `/api/v2/workspaces/${ws.workspace}/support-access/requests/${asked.data.id}/approve`,
    );
    expect(approved.status).toBe(200);
    expect(approved.data.status).toBe("approved");

    // The same visit, not a second one, now makes changes.
    const now = await visit();
    expect(now.data).toMatchObject({
      active: true,
      can_change: true,
      membership_id: joined.data.membership_id,
    });
    expect((await rename("Changed by staff")).status).toBe(200);
    const [project] = await db
      .select({ name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.id, ws.project));
    expect(project?.name).toBe("Changed by staff");

    // The visit ends 24 hours after the approval, and with it the right to change.
    const [request] = await db
      .select({
        resolvedAt: schema.support_access_request.resolved_at,
        membershipId: schema.support_access_request.membership_id,
      })
      .from(schema.support_access_request)
      .where(eq(schema.support_access_request.id, asked.data.id as string));
    expect(request?.membershipId).toBe(joined.data.membership_id as string);
    const approvedAt = new Date(request?.resolvedAt as string).getTime();
    expect(new Date(now.data.expires_at as string).getTime()).toBe(approvedAt + DAY_MS);
    expect(new Date(now.data.change_until as string).getTime()).toBe(approvedAt + DAY_MS);

    const store: AccessStore = new DrizzleAccessStore(db);
    const justBefore = await store.workspaceMembership(
      ws.workspace,
      people.staff.appUserId as string,
      new Date(approvedAt + DAY_MS - 1000),
    );
    expect(justBefore?.supportApproved).toBe(true);
    const after = await store.workspaceMembership(
      ws.workspace,
      people.staff.appUserId as string,
      new Date(approvedAt + DAY_MS + 1000),
    );
    expect(after).toBeNull();

    // Extending moves the end of the visit, not the end of the right to change, and the
    // account page's list says the same as the visit itself.
    await new Promise((r) => setTimeout(r, 20));
    const extended = await call(
      people.staff,
      "POST",
      `/api/v2/admin/workspaces/${ws.workspace}/join-support`,
    );
    expect(extended.data.status).toBe("extended");
    const later = await visit();
    expect(new Date(later.data.expires_at as string).getTime()).toBeGreaterThan(
      approvedAt + DAY_MS,
    );
    expect(new Date(later.data.change_until as string).getTime()).toBe(approvedAt + DAY_MS);
    const list = await call(people.staff, "GET", `/api/v2/admin/orgs/${ws.org}/workspaces`);
    expect(list.status).toBe(200);
    const row = (list.data.workspaces as { workspace_id: string; visit: unknown }[]).find(
      (w) => w.workspace_id === ws.workspace,
    );
    expect(row?.visit).toEqual(later.data);
    // Past the approval, the extended visit still reads.
    const between = await store.workspaceMembership(
      ws.workspace,
      people.staff.appUserId as string,
      new Date((approvedAt + DAY_MS + new Date(later.data.expires_at as string).getTime()) / 2),
    );
    expect(between).toMatchObject({ source: "staff_support", supportApproved: false });
  });
});
