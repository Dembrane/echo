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
import {
  allowanceForWorkspace,
  invalidateFreeLimits,
  requireProjectRoom,
  withAllowanceLock,
} from "@dembrane/allowance";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// Bypass review B: the project cap is account-wide, but its lock key carries the period.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_bypass_projects_${process.pid}`;
const OCT_END = new Date("2026-10-31T23:59:59.999Z");
const NOV = new Date("2026-11-01T00:00:00.000Z");

run("bypass: projects", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const apps = new Map<Date, Hono<Env>>();

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    for (const now of [OCT_END, NOV]) {
      const app = new Hono<Env>();
      app.use(async (c, next) => {
        c.set("principal", {
          appUserId: c.req.header("x-app"),
          directusUserId: c.req.header("x-directus") ?? null,
          isStaff: false,
        } as Signed);
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
          now: () => now,
        }),
      );
      app.onError((err, c) =>
        err instanceof PlatformError
          ? c.json({ code: err.code }, err.status as 400)
          : c.json({ detail: String(err) }, 500),
      );
      apps.set(now, app);
    }
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

  // A free org whose owner has an empty default workspace.
  async function freeWorkspace() {
    const owner = { app: newId(), directus: newId() };
    const email = `${owner.app}@example.com`;
    await sql`insert into directus_users (id, email) values (${owner.directus}, ${email})`;
    await sql`insert into app_user (id, directus_user_id, email) values (${owner.app}, ${owner.directus}, ${email})`;
    const org = newId();
    const ba = newId();
    const ws = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, tier, org_id) values (${ba}, 'free', ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${ba})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.app}, 'owner')`;
    return { owner, ws };
  }

  const createProject = (now: Date, p: { app: string; directus: string }, ws: string) =>
    (apps.get(now) as Hono<Env>).request(`/api/v2/workspaces/${ws}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app": p.app, "x-directus": p.directus },
      body: JSON.stringify({ name: "New", language: "en" }),
    });

  const liveProjects = async (ws: string) =>
    Number(
      (
        await sql`select count(*)::int as n from project where workspace_id = ${ws} and deleted_at is null`
      )[0]?.n ?? 0,
    );

  // Replays the first create's transaction (cap check + insert, uncommitted) at `first`,
  // fires a real create at `second` meanwhile, then commits the first.
  async function overlap(first: Date, second: Date) {
    const f = await freeWorkspace();
    const a = await allowanceForWorkspace(database.db, f.ws, first);
    if (!a) throw new Error("expected a free account");
    let res: Promise<Response> | null = null;
    let settled = false;
    let settledEarly = false;
    await withAllowanceLock(database.db, a, async (tx) => {
      await requireProjectRoom(tx, a);
      await tx.execute(dsql`insert into project (id, name, workspace_id, is_conversation_allowed)
        values (${newId()}::uuid, 'First', ${f.ws}::uuid, true)`);
      const pending = Promise.resolve(createProject(second, f.owner, f.ws));
      res = pending;
      pending.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 1500));
      settledEarly = settled;
    });
    const second_ = await (res as unknown as Promise<Response>);
    return { status: second_.status, settledEarly, live: await liveProjects(f.ws) };
  }

  test("control: an overlapping create in the same period waits and is refused", async () => {
    const r = await overlap(NOV, NOV);
    expect(r.settledEarly).toBe(false);
    expect(r.status).toBe(402);
    expect(r.live).toBe(1);
  });

  test("creates straddling the UTC month boundary still allow only one project", async () => {
    const r = await overlap(OCT_END, NOV);
    expect(r.status).toBe(402);
    expect(r.live).toBe(1);
  });
});
