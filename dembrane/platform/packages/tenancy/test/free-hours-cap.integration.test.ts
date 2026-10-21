import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { invalidateFreeLimits, setFreeLimit } from "@dembrane/allowance";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// Free hours shown anywhere are the live monthly audio limit, measured on the allowance ledger.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_free_hours_cap_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ORG = n("0a", 1);
const FREE_BA = n("ba", 1);
const PAID_BA = n("ba", 2);
const FREE_WS = n("c1", 1);
const PAID_WS = n("c1", 2);
const OWNER = { directus: n("d1", 1), app: n("a1", 1), email: "owner@example.com" };

type OrgRow = {
  id: string;
  audio_hours: number;
  hours_included: number | null;
  hours_counted: number | null;
  hours_pct: number | null;
  at_cap: boolean;
  approaching_cap: boolean;
};
type OrgUsage = {
  workspaces_at_cap: number;
  workspaces_approaching_cap: number;
  workspaces: OrgRow[];
};

run("free hours cap", () => {
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

    await sql`insert into org (id, name) values (${ORG}, 'Org')`;
    await sql`insert into billing_account (id, tier, org_id, created_at) values
      (${FREE_BA}, 'free', ${ORG}, '2026-01-01T00:00:00Z'), (${PAID_BA}, 'changemaker', null, now())`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values
      (${FREE_WS}, 'Free', ${ORG}, ${FREE_BA}), (${PAID_WS}, 'Paid', ${ORG}, ${PAID_BA})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values
      (${n("b1", 1)}, 'P', ${FREE_WS}, true)`;
    // Two hours this month: past the old one hour cap, well inside five.
    await sql`insert into conversation (id, project_id, participant_name, duration, created_at, updated_at) values
      (${n("e1", 1)}, ${n("b1", 1)}, 'P', 7200, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`;
    await sql`insert into directus_users (id, email) values (${OWNER.directus}, ${OWNER.email})`;
    await sql`insert into auth_user (id, email, email_verified, name) values (${OWNER.directus}, ${OWNER.email}, true, ${OWNER.email})`;
    await sql`insert into app_user (id, directus_user_id, email, display_name) values (${OWNER.app}, ${OWNER.directus}, ${OWNER.email}, ${OWNER.email})`;
    await sql`insert into org_membership (id, org_id, user_id, role) values (${n("f2", 1)}, ${ORG}, ${OWNER.app}, 'owner')`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values
      (${n("f1", 1)}, ${FREE_WS}, ${OWNER.app}, 'owner'), (${n("f1", 2)}, ${PAID_WS}, ${OWNER.app}, 'owner')`;

    app = new Hono<Env>();
    app.use(async (c, next) => {
      if (c.req.header("x-as"))
        c.set("principal", {
          appUserId: OWNER.app,
          directusUserId: OWNER.directus,
          isStaff: false,
        } satisfies Signed);
      await next();
    });
    app.route(
      "/",
      tenancyRoutes({
        db: database.db,
        accessStore: new DrizzleAccessStore(database.db),
        jobs: new MemoryJobSink(),
        dashboardUrl: "http://dashboard.test",
        inviteSecret: "h".repeat(32),
        now: () => NOW,
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

  const get = async <T>(path: string): Promise<T> => {
    const res = await app.request(path, { headers: { "x-as": "1" } });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const audioUsed = (seconds: number) =>
    sql`insert into free_usage (billing_account_id, period_start, key, amount) values
      (${FREE_BA}, '2026-10-01T00:00:00Z', 'audio_seconds', ${seconds})`;
  const hoursOf = (caps: { tier: string; included_hours: number | null }[]) =>
    Object.fromEntries(caps.map((c) => [c.tier, c.included_hours]));

  test("the tier matrix shows the live free monthly hours, paid tiers unlimited", async () => {
    type Cap = { tier: string; included_hours: number | null };
    expect(hoursOf(await get<Cap[]>("/api/v2/workspaces/tier-capacities"))).toEqual({
      free: 5,
      innovator: null,
      changemaker: null,
      guardian: null,
    });
    await setFreeLimit(database.db, "audio_seconds_month", 7200, null);
    expect(hoursOf(await get<Cap[]>("/api/v2/workspaces/tier-capacities")).free).toBe(2);
  });

  test("workspace cards and usage carry no free hours cap; the meter covers it", async () => {
    await audioUsed(18000);
    type Card = { id: string; usage: Record<string, unknown> };
    const list = await get<{ workspaces: Card[] } | Card[]>("/api/v2/workspaces");
    const cards = Array.isArray(list) ? list : list.workspaces;
    const card = cards.find((w) => w.id === FREE_WS);
    expect(card?.usage).toMatchObject({
      hours_included: null,
      hours_pct: null,
      at_cap: false,
      approaching_cap: false,
    });
    const usage = await get<{ audio_hours_included: number | null }>(
      `/api/v2/workspaces/${FREE_WS}/usage`,
    );
    expect(usage.audio_hours_included).toBeNull();
  });

  test("the org rollup measures a free workspace against the monthly limit on the ledger", async () => {
    const free = (u: OrgUsage) => u.workspaces.find((w) => w.id === FREE_WS);
    const paid = (u: OrgUsage) => u.workspaces.find((w) => w.id === PAID_WS);

    let u = await get<OrgUsage>(`/api/v2/orgs/${ORG}/usage`);
    expect(free(u)).toMatchObject({
      hours_included: 5,
      hours_counted: 0,
      hours_pct: 0,
      at_cap: false,
      approaching_cap: false,
    });
    expect(paid(u)).toMatchObject({
      hours_included: null,
      hours_counted: null,
      hours_pct: null,
      at_cap: false,
    });

    await audioUsed(15000);
    u = await get<OrgUsage>(`/api/v2/orgs/${ORG}/usage`);
    // The bar and the flags read the ledger, not the workspace's 2 calendar hours.
    expect(free(u)).toMatchObject({
      audio_hours: 2,
      hours_counted: 4.17,
      hours_pct: 0.833,
      at_cap: false,
      approaching_cap: true,
    });
    expect([u.workspaces_at_cap, u.workspaces_approaching_cap]).toEqual([0, 1]);

    await sql`update free_usage set amount = 18000`;
    u = await get<OrgUsage>(`/api/v2/orgs/${ORG}/usage`);
    expect(free(u)).toMatchObject({
      hours_counted: 5,
      hours_pct: 1,
      at_cap: true,
      approaching_cap: false,
    });
    expect([u.workspaces_at_cap, u.workspaces_approaching_cap]).toEqual([1, 0]);
    expect(u.workspaces[0]?.id).toBe(FREE_WS);

    await setFreeLimit(database.db, "audio_seconds_month", 36000, null);
    u = await get<OrgUsage>(`/api/v2/orgs/${ORG}/usage`);
    expect(free(u)).toMatchObject({ hours_included: 10, hours_pct: 0.5, at_cap: false });
  });

  test("a past month shows no free cap: the ledger only holds the current period", async () => {
    await audioUsed(18000);
    const u = await get<OrgUsage>(`/api/v2/orgs/${ORG}/usage?month_offset=1`);
    expect(u.workspaces.find((w) => w.id === FREE_WS)).toMatchObject({
      hours_included: null,
      hours_counted: null,
      hours_pct: null,
      at_cap: false,
      approaching_cap: false,
    });
  });
});
