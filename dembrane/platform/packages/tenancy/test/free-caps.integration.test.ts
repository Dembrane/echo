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

// The free tier's one-project cap on project creation and one-free-org cap on org creation.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_free_caps_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

type Person = { app: string; directus: string; email: string };
type Detail = { error?: string; limit?: string; used?: number; cap?: number };

run("free caps", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;
  let seq = 0;

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
      const app_ = c.req.header("x-app");
      if (app_)
        c.set("principal", {
          appUserId: app_,
          directusUserId: c.req.header("x-directus") ?? null,
          isStaff: c.req.header("x-staff") === "1",
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
        ? c.json({ code: err.code, detail: err.details ?? err.message }, err.status as 400)
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
    const p = { app: newId(), directus: newId(), email: `user${++seq}@example.com` };
    await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
    await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
    await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    return p;
  }

  async function org(): Promise<string> {
    const id = newId();
    await sql`insert into org (id, name) values (${id}, 'Org')`;
    return id;
  }

  async function account(tier: string, orgId: string | null): Promise<string> {
    const id = newId();
    await sql`insert into billing_account (id, tier, org_id) values (${id}, ${tier}, ${orgId})`;
    return id;
  }

  async function workspace(orgId: string, accountId: string, owner?: Person): Promise<string> {
    const id = newId();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${id}, 'W', ${orgId}, ${accountId})`;
    if (owner)
      await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${id}, ${owner.app}, 'owner')`;
    return id;
  }

  async function project(workspaceId: string, isSample = false): Promise<string> {
    const id = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample) values (${id}, 'P', ${workspaceId}, true, ${isSample})`;
    return id;
  }

  async function orgMember(orgId: string, p: Person, role: string, deleted = false) {
    await sql`insert into org_membership (id, org_id, user_id, role, deleted_at) values (${newId()}, ${orgId}, ${p.app}, ${role}, ${deleted ? NOW.toISOString() : null})`;
  }

  // An org with its free pooled account and one workspace the person owns.
  async function freeWorkspace(tier = "free") {
    const owner = await person();
    const o = await org();
    const ba = await account(tier, o);
    const ws = await workspace(o, ba, owner);
    return { owner, org: o, account: ba, ws };
  }

  const headers = (p: Person, staff = false) => ({
    "content-type": "application/json",
    "x-app": p.app,
    "x-directus": p.directus,
    ...(staff ? { "x-staff": "1" } : {}),
  });

  const createProject = (p: Person, ws: string, staff = false) =>
    app.request(`/api/v2/workspaces/${ws}/projects`, {
      method: "POST",
      headers: headers(p, staff),
      body: JSON.stringify({ name: "New", language: "en" }),
    });

  const createOrg = (p: Person, staff = false) =>
    app.request("/api/v2/orgs", {
      method: "POST",
      headers: headers(p, staff),
      body: JSON.stringify({ name: "Mine" }),
    });

  const projectCount = async (ws: string) => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from project where workspace_id = ${ws} and deleted_at is null`;
    return r?.n ?? 0;
  };

  async function expectRefused(res: Response, limit: string): Promise<Detail> {
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code: string; detail: Detail };
    expect(body.code).toBe("billing.tier_limit");
    expect(body.detail.error).toBe("FREE_TIER_LIMIT");
    expect(body.detail.limit).toBe(limit);
    return body.detail;
  }

  describe("projects", () => {
    test("the first project of a free account is created", async () => {
      const f = await freeWorkspace();
      const res = await createProject(f.owner, f.ws);
      expect(res.status).toBe(200);
      expect(await projectCount(f.ws)).toBe(1);
    });

    test("a second project is refused with the upgrade error", async () => {
      const f = await freeWorkspace();
      expect((await createProject(f.owner, f.ws)).status).toBe(200);
      const detail = await expectRefused(await createProject(f.owner, f.ws), "projects");
      expect(detail.used).toBe(1);
      expect(detail.cap).toBe(1);
      expect(await projectCount(f.ws)).toBe(1);
    });

    test("the cap counts across the pooled workspaces", async () => {
      const f = await freeWorkspace();
      const clientAccount = await account("free", null);
      const client = await workspace(f.org, clientAccount);
      await project(client);
      await expectRefused(await createProject(f.owner, f.ws), "projects");
      expect(await projectCount(f.ws)).toBe(0);
    });

    test("sample projects do not count", async () => {
      const f = await freeWorkspace();
      await project(f.ws, true);
      expect((await createProject(f.owner, f.ws)).status).toBe(200);
    });

    test("deleting the project frees the slot", async () => {
      const f = await freeWorkspace();
      const pid = await project(f.ws);
      await expectRefused(await createProject(f.owner, f.ws), "projects");
      await sql`update project set deleted_at = now() where id = ${pid}`;
      expect((await createProject(f.owner, f.ws)).status).toBe(200);
    });

    test("existing accounts with several projects keep them but cannot add", async () => {
      const f = await freeWorkspace();
      for (let i = 0; i < 3; i++) await project(f.ws);
      const detail = await expectRefused(await createProject(f.owner, f.ws), "projects");
      expect(detail.used).toBe(3);
      expect(await projectCount(f.ws)).toBe(3);
    });

    test("paid, pioneer and unknown tiers are untouched", async () => {
      for (const tier of ["changemaker", "pioneer", "mystery"]) {
        const f = await freeWorkspace(tier);
        for (let i = 0; i < 3; i++) expect((await createProject(f.owner, f.ws)).status).toBe(200);
        expect(await projectCount(f.ws)).toBe(3);
      }
    });

    test("staff are exempt", async () => {
      const f = await freeWorkspace();
      await project(f.ws);
      expect((await createProject(f.owner, f.ws, true)).status).toBe(200);
      expect(await projectCount(f.ws)).toBe(2);
    });

    test("concurrent creates on an empty free account: exactly one succeeds", async () => {
      const f = await freeWorkspace();
      const statuses = (
        await Promise.all(Array.from({ length: 5 }, () => createProject(f.owner, f.ws)))
      ).map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 402)).toHaveLength(4);
      expect(await projectCount(f.ws)).toBe(1);
    });
  });

  describe("organisations", () => {
    async function memberOf(tier: string | null, role: string) {
      const p = await person();
      const o = await org();
      if (tier) await account(tier, o);
      await orgMember(o, p, role);
      return { p, o };
    }

    test("an owner of a free org cannot create another", async () => {
      const { p } = await memberOf("free", "owner");
      await expectRefused(await createOrg(p), "organisations");
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from org_membership where user_id = ${p.app}`;
      expect(r?.n).toBe(1);
    });

    test("so can't an admin", async () => {
      const { p } = await memberOf("free", "admin");
      await expectRefused(await createOrg(p), "organisations");
    });

    test("a member of a free org can", async () => {
      const { p } = await memberOf("free", "member");
      expect((await createOrg(p)).status).toBe(200);
    });

    test("an owner of only paid or pioneer orgs can", async () => {
      const { p } = await memberOf("changemaker", "owner");
      const pioneer = await org();
      await account("pioneer", pioneer);
      await orgMember(pioneer, p, "owner");
      expect((await createOrg(p)).status).toBe(200);
    });

    test("the org's pooled account is its oldest live one", async () => {
      const p = await person();
      const o = await org();
      await sql`insert into billing_account (id, tier, org_id, created_at) values
        (${newId()}, 'changemaker', ${o}, '2026-01-01'),
        (${newId()}, 'free', ${o}, '2026-02-01')`;
      await orgMember(o, p, "owner");
      expect((await createOrg(p)).status).toBe(200);
    });

    test("a deleted org or a removed membership does not count", async () => {
      const { p, o } = await memberOf("free", "owner");
      await sql`update org set deleted_at = now() where id = ${o}`;
      const removed = await org();
      await account("free", removed);
      await orgMember(removed, p, "owner", true);
      expect((await createOrg(p)).status).toBe(200);
    });

    test("an org with no billing account does not count", async () => {
      const { p } = await memberOf(null, "owner");
      expect((await createOrg(p)).status).toBe(200);
    });

    test("the refusal names the blocking free org and its default workspace", async () => {
      const p = await person();
      const paid = await org();
      await workspace(paid, await account("changemaker", paid), p);
      await orgMember(paid, p, "owner");
      const f = await freeWorkspace();
      await sql`update workspace set is_default = true where id = ${f.ws}`;
      await workspace(f.org, f.account);
      await orgMember(f.org, p, "admin");
      const detail = (await expectRefused(await createOrg(p), "organisations")) as Detail & {
        org_id?: string;
        workspace_id?: string;
      };
      expect(detail.org_id).toBe(f.org);
      expect(detail.workspace_id).toBe(f.ws);
    });

    test("parallel creates by a new user: exactly one succeeds", async () => {
      const p = await person();
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => createOrg(p)))).map(
        (r) => r.status,
      );
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 402)).toHaveLength(4);
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from org_membership where user_id = ${p.app}`;
      expect(r?.n).toBe(1);
    });

    test("a user with no org can", async () => {
      expect((await createOrg(await person())).status).toBe(200);
    });

    test("staff can", async () => {
      const { p } = await memberOf("free", "owner");
      expect((await createOrg(p, true)).status).toBe(200);
    });
  });
});
