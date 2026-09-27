import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@echo/access";
import { createBilling, FakeMollie } from "@echo/billing";
import { PlatformError } from "@echo/core";
import { createDb, schema } from "@echo/db";
import type { Env, Signed } from "@echo/http";
import { MemoryMailer } from "@echo/mail";
import { createLogger } from "@echo/observability";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { runExpireSupport, runSupportTimers, staffRoutes } from "../src";

// Runs against a copy of the parity template (seeded orgs, workspaces and users) when a
// Postgres admin URL is given: TEST_DATABASE_ADMIN_URL=postgres://dembrane:dembrane@localhost:5440/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_test_${process.pid}`;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";

const WS = "c0000000-0000-4000-8000-000000000001"; // org A, Default (staff is a member)
const WS2 = "c0000000-0000-4000-8000-000000000002"; // org A, Research (staff is not)
const ACC = "ba000000-0000-4000-8000-000000000001";
// The seeded Directus Administrator ("admin" in parity/fixtures.ts).
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

run("staff console against Postgres", () => {
  setDefaultTimeout(30_000);
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;
  const mailer = new MemoryMailer();
  let now = new Date();
  const clock = () => now;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    for (let i = 0; ; i++) {
      try {
        await a.unsafe(`create database ${dbName} template parity_template_platform`);
        break;
      } catch (e) {
        // The parity runner may be copying the same template this instant.
        if (i > 20) throw e;
        await Bun.sleep(500);
      }
    }
    await a.end();
    database = createDb({ url, poolMax: 4 });
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
      clock,
    });
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
        clock,
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (as: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "x-as": as, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const db = () => database.db;
  type Json = Record<string, string>;
  const json = async (r: Response | Promise<Response>) => (await (await r).json()) as Json;

  test("every staff use is audited with its permission; refusals leave no trail", async () => {
    const res = await call("staff", "PATCH", `/api/v2/admin/billing-accounts/${ACC}/discount`, {
      percent_discount: 20,
    });
    expect(res.status).toBe(200);
    const refused = await call("alice", "GET", "/api/v2/admin/billing-rollup");
    expect(refused.status).toBe(403);
    const audit = await db().select().from(schema.staff_audit_event);
    expect(
      audit.map((a) => [a.permission, a.action, a.targetId, a.staffUserId, a.requestId]),
    ).toEqual([
      ["staff:billing", "billing_account.discount.update", ACC, STAFF.directusUserId, "req-1"],
    ]);
    const [acc] = await db()
      .select()
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, ACC));
    expect(acc?.percent_discount).toBe(20);
  });

  test("join, extend and timed revoke of a support session, ending with the toggle off", async () => {
    await db()
      .update(schema.workspace)
      .set({ allow_support_access: true })
      .where(eq(schema.workspace.id, WS2));
    now = new Date("2026-09-27T10:00:00Z");
    const joined = await json(
      call("staff", "POST", `/api/v2/admin/workspaces/${WS2}/join-support`),
    );
    expect(joined).toMatchObject({ status: "joined", role: "admin", workspace_id: WS2 });
    const extended = await json(
      call("staff", "POST", `/api/v2/admin/workspaces/${WS2}/join-support`),
    );
    expect(extended).toMatchObject({ status: "extended", membership_id: joined.membership_id });

    const tasks = await db()
      .select()
      .from(schema.scheduled_task)
      .where(eq(schema.scheduled_task.task_type, "revoke_staff_support"));
    expect(tasks.map((t) => t.status).sort()).toEqual(["cancelled", "scheduled"]);
    const status = await json(call("staff", "GET", `/api/v2/admin/workspaces/${WS2}/join-support`));
    expect(status).toMatchObject({ active: true, membership_id: joined.membership_id });

    // A day later the timer fires.
    now = new Date("2026-09-28T10:00:01Z");
    const deps = {
      db: db(),
      billing: createBilling({
        db: db(),
        mollie: new FakeMollie(),
        mailer,
        logger,
        billingConfig: {
          webhookUrl: null,
          forceReconcileFailure: false,
          dashboardUrl: "https://dash.test",
        },
        clock,
      }),
      mailer,
      logger,
      dashboardUrl: "https://dash.test",
      clock,
    };
    await runSupportTimers(deps);
    const [m] = await db()
      .select()
      .from(schema.workspace_membership)
      .where(eq(schema.workspace_membership.id, String(joined.membership_id)));
    expect(m?.deleted_at).not.toBeNull();
    const [ws] = await db().select().from(schema.workspace).where(eq(schema.workspace.id, WS2));
    expect(ws?.allow_support_access).toBe(false);
    const events = await db()
      .select({ code: schema.support_access_event.event_code })
      .from(schema.support_access_event)
      .where(eq(schema.support_access_event.workspace_id, WS2));
    expect(events.map((e) => e.code)).toEqual([
      "staff_joined",
      "staff_extended",
      "staff_auto_revoked",
      "toggle_auto_disabled",
    ]);
    const ended = await db()
      .select({ to: schema.notification.audience_user_id })
      .from(schema.notification)
      .where(eq(schema.notification.event_code, "SUPPORT_ACCESS_ENDED"));
    expect(ended.length).toBeGreaterThan(0);
    expect(mailer.sent.some((x) => x.tags?.includes("support_access_ended"))).toBe(true);
    const settled = await db()
      .select()
      .from(schema.scheduled_task)
      .where(
        and(
          eq(schema.scheduled_task.task_type, "revoke_staff_support"),
          eq(schema.scheduled_task.status, "completed"),
        ),
      );
    expect(settled).toHaveLength(1);
    // The sweep finds nothing left to do, and a second timer run is a no-op.
    await runExpireSupport(deps);
    await runSupportTimers(deps);
  });

  test("a support request expires on its timer and tells the requester", async () => {
    now = new Date("2026-09-27T10:00:00Z");
    const req = await json(
      call("staff", "POST", `/api/v2/admin/workspaces/${WS}/support-access/request`, {
        message: " hi ",
      }),
    );
    expect(req).toMatchObject({ status: "pending", message: "hi", workspace_id: WS });
    const again = await json(
      call("staff", "POST", `/api/v2/admin/workspaces/${WS}/support-access/request`, {}),
    );
    expect(again.id).toBe(req.id);
    now = new Date("2026-10-04T10:00:01Z");
    await runSupportTimers({
      db: db(),
      billing: createBilling({
        db: db(),
        mollie: new FakeMollie(),
        mailer,
        logger,
        billingConfig: {
          webhookUrl: null,
          forceReconcileFailure: false,
          dashboardUrl: "https://dash.test",
        },
        clock,
      }),
      mailer,
      logger,
      dashboardUrl: "https://dash.test",
      clock,
    });
    const [row] = await db()
      .select()
      .from(schema.support_access_request)
      .where(eq(schema.support_access_request.id, String(req.id)));
    expect(row?.status).toBe("expired");
    const notes = await db()
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.event_code, "SUPPORT_REQUEST_EXPIRED"));
    expect(notes.map((n) => n.audience_user_id)).toEqual([STAFF.appUserId as string]);
  });

  test("managed mode round trip: set managed, refuse a live subscription, back to self-serve", async () => {
    const managed = await call(
      "staff",
      "POST",
      `/api/v2/admin/billing-accounts/${ACC}/set-managed`,
      {
        tier: "guardian",
        seats: 7,
      },
    );
    expect(managed.status).toBe(200);
    let [acc] = await db()
      .select()
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, ACC));
    expect(acc).toMatchObject({
      payment_mode: "offline",
      tier: "guardian",
      provisioned_seats: 7,
      status: "active",
    });
    const saas = await call("staff", "POST", `/api/v2/admin/billing-accounts/${ACC}/set-saas`, {
      to_free: false,
      expires_at: "2026-12-31T00:00:00+00:00",
    });
    expect(saas.status).toBe(200);
    [acc] = await db()
      .select()
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, ACC));
    expect(acc).toMatchObject({ payment_mode: "none", tier: "guardian" });
    await db()
      .update(schema.billing_account)
      .set({ payment_mode: "mollie", mollie_subscription_id: "sub_1" })
      .where(eq(schema.billing_account.id, ACC));
    const refused = await call(
      "staff",
      "POST",
      `/api/v2/admin/billing-accounts/${ACC}/set-managed`,
      {
        tier: "changemaker",
      },
    );
    expect(refused.status).toBe(409);
  });

  test("the rollup forecasts paying accounts from pooled seats and zeroes comped ones", async () => {
    await db()
      .update(schema.billing_account)
      .set({
        payment_mode: "mollie",
        tier: "changemaker",
        billing_period: "monthly",
        percent_discount: 10,
        type_discount: null,
      })
      .where(eq(schema.billing_account.id, ACC));
    const res = await call("staff", "GET", "/api/v2/admin/billing-rollup");
    const body = (await res.json()) as {
      accounts: { billing_account_id: string; tier: string }[];
      mrr_eur: number;
    };
    const a = body.accounts.find((x) => x.billing_account_id === ACC);
    // Org A pools 4 distinct seat holders: 4 x EUR 86 monthly, less 10%.
    expect(a).toMatchObject({ is_comped: false, total_forecast_eur: 309.6, workspace_count: 2 });
    const b = body.accounts.find((x) => x.tier === "free");
    expect(b).toMatchObject({ is_comped: false, total_forecast_eur: 0 });
    expect(body.mrr_eur).toBe(309.6);
  });
});
