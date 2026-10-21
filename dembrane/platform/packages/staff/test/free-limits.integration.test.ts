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
import {
  FREE_LIMIT_DEFAULTS,
  freeLimits,
  invalidateFreeLimits,
  LIMIT_KEYS,
} from "@dembrane/allowance";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { staffRoutes } from "../src";

// Staff read and edit the free tier limits; every edit names who made it.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_free_limits_${process.pid}`;

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

type Row = {
  key: string;
  value: number;
  default: number;
  updated_by: string | null;
  updated_by_name: string | null;
};

run("staff free limits", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    await database.db.insert(schema.directus_users).values({
      id: STAFF.directusUserId,
      email: "sam@dembrane.com",
      first_name: "Sam",
      last_name: "Staff",
    });
    const mailer = new MemoryMailer();
    const clock = () => new Date();
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
  const put = (key: string, value: unknown, as = "staff") =>
    call(as, "PUT", `/api/v2/admin/free-limits/${key}`, { value });
  const audits = (action: string) =>
    database.db
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.action, action));

  test("lists every key with defaults", async () => {
    const res = await call("staff", "GET", "/api/v2/admin/free-limits");
    expect(res.status).toBe(200);
    const { limits } = (await res.json()) as { limits: Row[] };
    expect(limits.map((r) => r.key)).toEqual([...LIMIT_KEYS]);
    for (const r of limits) {
      expect(r.value).toBe(FREE_LIMIT_DEFAULTS[r.key as keyof typeof FREE_LIMIT_DEFAULTS]);
      expect(r.default).toBe(r.value);
      expect(r.updated_by).toBeNull();
      expect(r.updated_by_name).toBeNull();
    }
  });

  test("updates a key and records the actor", async () => {
    const res = await put("chats_month", 4);
    expect(res.status).toBe(200);
    const { limits } = (await res.json()) as { limits: Row[] };
    const row = limits.find((r) => r.key === "chats_month");
    expect(row).toMatchObject({
      value: 4,
      default: 2,
      updated_by: STAFF.directusUserId,
      updated_by_name: "Sam Staff (sam@dembrane.com)",
    });
    const [stored] = await database.db
      .select()
      .from(schema.tier_limit)
      .where(eq(schema.tier_limit.key, "chats_month"));
    expect(stored).toMatchObject({ tier: "free", value: 4, updated_by: STAFF.directusUserId });
    const trail = await audits("free_limit.update");
    expect(trail.map((a) => [a.permission, a.staffUserId, a.detail, a.requestId])).toEqual([
      ["staff:set_tier", STAFF.directusUserId, { key: "chats_month", value: 4 }, "req-1"],
    ]);
  });

  test("rejects invalid values", async () => {
    for (const value of [-1, 1.5, "5", 10_000_001, true, null]) {
      const res = await put("reports_month", value);
      expect(res.status).toBe(400);
    }
    expect((await put("bogus", 5)).status).toBe(400);
    expect((await put("reports_month", 10_000_000)).status).toBe(200);
    expect((await put("reports_month", 0)).status).toBe(200);
  });

  test("a value of 0 is stored and served", async () => {
    expect((await put("maps_month", 0)).status).toBe(200);
    const [stored] = await database.db
      .select()
      .from(schema.tier_limit)
      .where(eq(schema.tier_limit.key, "maps_month"));
    expect(stored?.value).toBe(0);
    invalidateFreeLimits();
    expect((await freeLimits(database.db)).maps_month).toBe(0);
    const res = await call("staff", "GET", "/api/v2/admin/free-limits");
    const { limits } = (await res.json()) as { limits: Row[] };
    expect(limits.find((r) => r.key === "maps_month")?.value).toBe(0);
    await database.db.delete(schema.tier_limit).where(eq(schema.tier_limit.key, "maps_month"));
  });

  test("a non-staff caller gets 403", async () => {
    expect((await call("alice", "GET", "/api/v2/admin/free-limits")).status).toBe(403);
    expect((await put("maps_month", 3, "alice")).status).toBe(403);
    const [stored] = await database.db
      .select()
      .from(schema.tier_limit)
      .where(eq(schema.tier_limit.key, "maps_month"));
    expect(stored).toBeUndefined();
  });
});
