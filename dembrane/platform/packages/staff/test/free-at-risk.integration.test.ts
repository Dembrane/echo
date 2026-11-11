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
import { invalidateFreeLimits, setFreeLimit } from "@dembrane/allowance";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { Hono } from "hono";
import type postgres from "postgres";
import { staffRoutes } from "../src";

// Staff at-risk lists free workspaces at their monthly audio limit, read from the ledger.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_free_at_risk_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ORG = n("0a", 1);
const OTHER_ORG = n("0a", 2);
const POOL = n("ba", 1);
const CLIENT_BA = n("ba", 2);
const LAST_MONTH_BA = n("ba", 3);
const PAID_BA = n("ba", 4);
const POOL_WS = n("c1", 1);
const CLIENT_WS = n("c1", 2);
const LAST_MONTH_WS = n("c1", 3);
const PAID_WS = n("c1", 4);

const STAFF: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000001",
  directusUserId: "d0000000-0000-4000-8000-000000000001",
  isStaff: true,
};

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "warn" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

type Item = { workspace_id: string; reason: string; detail: string };

run("staff at-risk free audio", () => {
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

    await sql`insert into org (id, name) values (${ORG}, 'Org'), (${OTHER_ORG}, 'Other')`;
    // The org's free pool, a free client workspace pooled into it, an unrelated free
    // account whose ledger row is last month's, and a paid account.
    await sql`insert into billing_account (id, tier, org_id, created_at) values
      (${POOL}, 'free', ${ORG}, '2026-01-01T00:00:00Z'),
      (${CLIENT_BA}, 'free', null, '2026-02-01T00:00:00Z'),
      (${LAST_MONTH_BA}, 'free', null, '2026-03-01T00:00:00Z'),
      (${PAID_BA}, 'changemaker', null, '2026-04-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values
      (${POOL_WS}, 'Pool', ${ORG}, ${POOL}),
      (${CLIENT_WS}, 'Client', ${ORG}, ${CLIENT_BA}),
      (${LAST_MONTH_WS}, 'Old', ${OTHER_ORG}, ${LAST_MONTH_BA}),
      (${PAID_WS}, 'Paid', ${OTHER_ORG}, ${PAID_BA})`;

    const mailer = new MemoryMailer();
    const clock = () => NOW;
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
      c.set("requestId", "req-1");
      c.set("principal", c.req.header("x-as") === "staff" ? STAFF : null);
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

  beforeEach(async () => {
    invalidateFreeLimits();
    await sql`delete from tier_limit`;
    await sql`delete from free_usage`;
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const atRisk = async () => {
    const res = await app.request("/api/v2/admin/at-risk", { headers: { "x-as": "staff" } });
    expect(res.status).toBe(200);
    return ((await res.json()) as Item[]).filter((i) => i.reason === "at_cap");
  };
  const audio = (account: string, period: string, seconds: number) =>
    sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${account}, ${period}, 'audio_seconds', ${seconds})`;

  test("below the limit nothing is at cap", async () => {
    await audio(POOL, "2026-10-01T00:00:00Z", 17999);
    expect(await atRisk()).toEqual([]);
  });

  test("a pooled account at its limit lists every workspace on it; last month's does not count", async () => {
    await audio(POOL, "2026-10-01T00:00:00Z", 18000);
    await audio(LAST_MONTH_BA, "2026-09-01T00:00:00Z", 30000);
    const items = await atRisk();
    expect(items.map((i) => i.workspace_id).sort()).toEqual([POOL_WS, CLIENT_WS].sort());
    expect(items[0]?.detail).toBe("5.0h / 5h free monthly limit");
  });

  test("the limit staff set is the one measured", async () => {
    await audio(POOL, "2026-10-01T00:00:00Z", 7200);
    expect(await atRisk()).toEqual([]);
    await setFreeLimit(database.db, "audio_seconds_month", 7200, null);
    const items = await atRisk();
    expect(items.map((i) => i.workspace_id).sort()).toEqual([POOL_WS, CLIENT_WS].sort());
    expect(items[0]?.detail).toBe("2.0h / 2h free monthly limit");
  });
});
