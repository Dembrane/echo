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
import { invalidateFreeLimits } from "@dembrane/allowance";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// The free allowance meter: members read their workspace's snapshot; others get what usage gives them.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_free_allowance_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ORG = n("0a", 1);
const FREE_BA = n("ba", 1);
const PAID_BA = n("ba", 2);
const FREE_WS = n("c1", 1);
const PAID_WS = n("c1", 2);

type Person = { directus: string; app: string; email: string };
const person = (k: number, name: string): Person => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `${name}@example.com`,
});
// alice is a member of both workspaces, olga an observer of the free one, bob of neither.
const P = { alice: person(1, "alice"), olga: person(2, "olga"), bob: person(3, "bob") };

run("free allowance route", () => {
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
    await sql`insert into billing_account (id, tier, org_id) values
      (${FREE_BA}, 'free', ${ORG}), (${PAID_BA}, 'changemaker', null)`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values
      (${FREE_WS}, 'Free', ${ORG}, ${FREE_BA}), (${PAID_WS}, 'Paid', ${ORG}, ${PAID_BA})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values
      (${n("b1", 1)}, 'P', ${FREE_WS}, true)`;
    await sql`insert into free_usage (billing_account_id, period_start, key, amount) values
      (${FREE_BA}, '2026-10-01T00:00:00Z', 'chats', 1)`;
    for (const p of Object.values(P)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    }
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values
      (${n("f1", 1)}, ${FREE_WS}, ${P.alice.app}, 'member'),
      (${n("f1", 2)}, ${PAID_WS}, ${P.alice.app}, 'member'),
      (${n("f1", 3)}, ${FREE_WS}, ${P.olga.app}, 'observer')`;

    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = Object.values(P).find((p) => p.email === c.req.header("x-as"));
      if (who)
        c.set("principal", {
          appUserId: who.app,
          directusUserId: who.directus,
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

  beforeEach(() => invalidateFreeLimits());

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const get = (as: Person, ws: string, what: "free-allowance" | "usage") =>
    app.request(`/api/v2/workspaces/${ws}/${what}`, { headers: { "x-as": as.email } });

  test("a member of a free workspace gets the snapshot", async () => {
    const res = await get(P.alice, FREE_WS, "free-allowance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      free: true,
      scope: "organisation",
      period_start: "2026-10-01T00:00:00.000Z",
      resets_at: "2026-11-01T00:00:00.000Z",
      audio_seconds: { used: 0, limit: 18000 },
      chats: { used: 1, limit: 2 },
      reports: { used: 0, limit: 1 },
      maps: { used: 0, limit: 1 },
      popcorn_analyses: { used: 0, limit: 12 },
      projects: { used: 1, limit: 1 },
    });
  });

  test("a member of a paid workspace is told it is not free", async () => {
    const res = await get(P.alice, PAID_WS, "free-allowance");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { free: boolean }).free).toBe(false);
  });

  test("a non-member is refused as the usage route refuses them", async () => {
    const usage = await get(P.bob, FREE_WS, "usage");
    expect([403, 404]).toContain(usage.status);
    const res = await get(P.bob, FREE_WS, "free-allowance");
    expect(res.status).toBe(usage.status);
    expect(await res.json()).toEqual(await usage.json());
  });

  test("an observer without view_usage is refused as the usage route refuses them", async () => {
    const usage = await get(P.olga, FREE_WS, "usage");
    expect(usage.status).toBe(403);
    const res = await get(P.olga, FREE_WS, "free-allowance");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(await usage.json());
  });
});
