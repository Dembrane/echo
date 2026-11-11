import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { staffRoutes } from "../src";

// Staff tier moves stamp or clear the downgrade the way the workspace tier change does.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_tier_moves_${process.pid}`;

const STAFF: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000001",
  directusUserId: "d0000000-0000-4000-8000-000000000001",
  isStaff: true,
};

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "warn" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("staff tier moves", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;
  const now = new Date("2026-10-15T12:00:00.000Z");
  const clock = () => now;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
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
      clock,
    });
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = c.req.header("x-as");
      c.set("requestId", "req-1");
      c.set("principal", who === "staff" ? STAFF : null);
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
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  beforeEach(() => invalidateFreeLimits());

  afterAll(async () => {
    invalidateFreeLimits();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (as: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "x-as": as, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const ACC = "ba000000-0000-4000-8000-0000000000aa";
  const EARLIER = "2026-09-01T00:00:00.000Z";
  const reset = (set: Partial<typeof schema.billing_account.$inferInsert>) =>
    database.db
      .insert(schema.billing_account)
      .values({ id: ACC, ...set })
      .onConflictDoUpdate({
        target: schema.billing_account.id,
        set: {
          downgraded_at: null,
          downgraded_from_tier: null,
          mollie_subscription_id: null,
          ...set,
        },
      });
  const account = async () => {
    const [acc] = await database.db
      .select()
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, ACC));
    return acc;
  };
  const managed = (tier: string) =>
    call("staff", "POST", `/api/v2/admin/billing-accounts/${ACC}/set-managed`, { tier });
  const toFree = () =>
    call("staff", "POST", `/api/v2/admin/billing-accounts/${ACC}/set-saas`, { to_free: true });
  const stamp = (acc: Awaited<ReturnType<typeof account>>) => ({
    at: acc?.downgraded_at ? new Date(acc.downgraded_at).toISOString() : null,
    from: acc?.downgraded_from_tier ?? null,
  });

  test("set-saas to free from a paid tier stamps the downgrade", async () => {
    await reset({ tier: "guardian", payment_mode: "offline" });
    expect((await toFree()).status).toBe(200);
    const acc = await account();
    expect(acc?.tier).toBe("free");
    expect(stamp(acc)).toEqual({ at: now.toISOString(), from: "guardian" });
  });

  test("set-managed to free from a paid tier stamps the downgrade", async () => {
    await reset({ tier: "changemaker", payment_mode: "none" });
    expect((await managed("free")).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: now.toISOString(), from: "changemaker" });
  });

  test("a legacy tier moved to free stamps the downgrade", async () => {
    await reset({ tier: "pioneer", payment_mode: "offline" });
    expect((await toFree()).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: now.toISOString(), from: "pioneer" });
  });

  test("set-managed from a legacy tier to free stamps the downgrade", async () => {
    await reset({ tier: "pioneer", payment_mode: "none" });
    expect((await managed("free")).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: now.toISOString(), from: "pioneer" });
  });

  test("set-managed paid to a lower paid tier stamps, to a higher one clears", async () => {
    await reset({ tier: "guardian", payment_mode: "none" });
    expect((await managed("innovator")).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: now.toISOString(), from: "guardian" });
    expect((await managed("changemaker")).status).toBe(200);
    const acc = await account();
    expect(acc?.tier).toBe("changemaker");
    expect(stamp(acc)).toEqual({ at: null, from: null });
  });

  test("set-managed from free to a paid tier clears the downgrade", async () => {
    await reset({ tier: "free", downgraded_at: EARLIER, downgraded_from_tier: "guardian" });
    expect((await managed("innovator")).status).toBe(200);
    const acc = await account();
    expect(acc?.tier).toBe("innovator");
    expect(stamp(acc)).toEqual({ at: null, from: null });
  });

  test("free to free changes nothing", async () => {
    await reset({ tier: "free", downgraded_at: EARLIER, downgraded_from_tier: "guardian" });
    expect((await managed("free")).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: EARLIER, from: "guardian" });
    await database.db
      .update(schema.billing_account)
      .set({ payment_mode: "offline" })
      .where(eq(schema.billing_account.id, ACC));
    expect((await toFree()).status).toBe(200);
    expect(stamp(await account())).toEqual({ at: EARLIER, from: "guardian" });
  });
});
