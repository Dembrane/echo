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
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// Bypass review B2: a sole owner steps down to admin, removes themselves, then creates a fresh free org.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_bypass_stepdown_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

type Person = { app: string; directus: string; email: string };

run("bypass: one free org per manager, step down and leave", () => {
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
    database = createDb({ url, poolMax: 6 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    app = new Hono<Env>();
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

  async function person(): Promise<Person> {
    const p = { app: newId(), directus: newId(), email: `${newId()}@example.com` };
    await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
    await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
    await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    return p;
  }

  const call = (p: Person, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-app": p.app, "x-directus": p.directus },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const json = async (r: Response) => ({
    status: r.status,
    code: ((await r.json()) as { code?: string }).code,
  });

  async function orgOf(owner: Person): Promise<string> {
    const r = await call(owner, "POST", "/api/v2/orgs", { name: "Org" });
    expect(r.status).toBe(200);
    return ((await r.json()) as { org_id: string }).org_id;
  }

  async function join(org: string, p: Person, role: string) {
    await sql`insert into org_membership (id, org_id, user_id, role) values (${newId()}, ${org}, ${p.app}, ${role})`;
  }

  test("a sole owner cannot leave their free org to get a fresh one", async () => {
    const me = await person();
    const oldOrg = await orgOf(me);
    expect((await call(me, "POST", "/api/v2/orgs", { name: "Second" })).status).toBe(402);

    // Alone in the org: owner -> admin, then remove self.
    const demote = await call(me, "PATCH", `/api/v2/orgs/${oldOrg}/members/${me.app}`, {
      role: "admin",
    });
    expect(await json(demote)).toEqual({ status: 400, code: "member.last_owner_demote" });
    const leave = await call(me, "DELETE", `/api/v2/orgs/${oldOrg}/members/${me.app}`);
    expect(await json(leave)).toEqual({ status: 409, code: "member.last_owner" });

    const again = await call(me, "POST", "/api/v2/orgs", { name: "Fresh" });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from billing_account b join org o on o.id = b.org_id
      where o.created_by = ${me.app} and b.tier = 'free' and b.deleted_at is null`;
    expect({ status: again.status, freeAccounts: row?.n }).toEqual({
      status: 402,
      freeAccounts: 1,
    });
  });

  test("the last owner cannot step down while only an admin remains", async () => {
    const owner = await person();
    const admin = await person();
    const org = await orgOf(owner);
    await join(org, admin, "admin");
    const r = await call(owner, "PATCH", `/api/v2/orgs/${org}/members/${owner.app}`, {
      role: "admin",
    });
    expect(await json(r)).toEqual({ status: 400, code: "member.last_owner_demote" });
  });

  test("the last manager cannot leave", async () => {
    const owner = await person();
    const admin = await person();
    const org = await orgOf(owner);
    await join(org, admin, "admin");
    // An org left with only an admin (as before the fix).
    await sql`update org_membership set deleted_at = now() where org_id = ${org} and user_id = ${owner.app}`;
    const leave = await call(admin, "DELETE", `/api/v2/orgs/${org}/members/${admin.app}`);
    expect(await json(leave)).toEqual({ status: 400, code: "member.sole_admin_leave" });
  });

  test("a manager may leave while another manager stays", async () => {
    const owner = await person();
    const admin = await person();
    const org = await orgOf(owner);
    await join(org, admin, "admin");
    expect((await call(admin, "DELETE", `/api/v2/orgs/${org}/members/${admin.app}`)).status).toBe(
      200,
    );
    await join(org, admin, "owner");
    expect(
      (
        await call(owner, "PATCH", `/api/v2/orgs/${org}/members/${owner.app}`, {
          role: "admin",
        })
      ).status,
    ).toBe(200);
    expect((await call(admin, "DELETE", `/api/v2/orgs/${org}/members/${owner.app}`)).status).toBe(
      200,
    );
  });
});
