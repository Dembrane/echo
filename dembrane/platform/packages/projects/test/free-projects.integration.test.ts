import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { bulkMoveProjects, cloneProject, moveProject, type ProjectDeps } from "../src/projects";
import { projectRoutes } from "../src/routes";
import { projectsStorage } from "../src/storage";

// The free project cap on clone and move, and the recording project routes.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_free_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

type Person = Signed & { appUserId: string; directusUserId: string };
type Detail = { error?: string; limit?: string; used?: number; cap?: number };

run("free projects", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
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
    const access = new Access(new DrizzleAccessStore(database.db));
    const jobs = { enqueue: async () => "job" };
    d = { db: database.db, store: projectsStorage(database.db), access, jobs, now: () => NOW };
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const id = c.req.header("x-app");
      if (id)
        c.set("principal", {
          appUserId: id,
          directusUserId: c.req.header("x-directus") ?? null,
          isStaff: false,
        } as Signed);
      await next();
    });
    app.route("/", projectRoutes({ db: database.db, access, queue: jobs, now: () => NOW }));
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

  async function person(isStaff = false): Promise<Person> {
    const p = { appUserId: newId(), directusUserId: newId(), isStaff };
    await sql`insert into directus_users (id) values (${p.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${p.appUserId}, ${p.directusUserId})`;
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

  async function workspace(
    orgId: string,
    accountId: string,
    members: [Person, string][],
  ): Promise<string> {
    const id = newId();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${id}, 'W', ${orgId}, ${accountId})`;
    for (const [p, role] of members)
      await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${id}, ${p.appUserId}, ${role})`;
    return id;
  }

  async function project(
    workspaceId: string | null,
    opts: { sample?: boolean; owner?: Person } = {},
  ): Promise<string> {
    const id = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample, directus_user_id)
      values (${id}, 'P', ${workspaceId}, true, ${opts.sample ?? false}, ${opts.owner?.directusUserId ?? null})`;
    return id;
  }

  async function space(tier = "free", extra: [Person, string][] = []) {
    const owner = await person();
    const o = await org();
    const ba = await account(tier, o);
    const ws = await workspace(o, ba, [[owner, "owner"], ...extra]);
    return { owner, org: o, account: ba, ws };
  }

  const liveCount = async (ws: string) => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from project
      where workspace_id = ${ws} and deleted_at is null and is_sample = false`;
    return r?.n ?? 0;
  };

  const workspaceOf = async (id: string) => {
    const [r] = await sql<
      { w: string | null }[]
    >`select workspace_id as w from project where id = ${id}`;
    return r?.w ?? null;
  };

  async function refused(p: Promise<unknown>, limit: string): Promise<Detail> {
    const err = await Promise.resolve(p).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("billing.tier_limit");
    const detail = err.details as Detail;
    expect(detail.error).toBe("FREE_TIER_LIMIT");
    expect(detail.limit).toBe(limit);
    return detail;
  }

  describe("clone", () => {
    test("cloning in a free account with a project is refused", async () => {
      const f = await space();
      const src = await project(f.ws);
      const detail = await refused(
        cloneProject(d, f.owner, src, { name: null, language: null }),
        "projects",
      );
      expect(detail.used).toBe(1);
      expect(detail.cap).toBe(1);
      expect(await liveCount(f.ws)).toBe(1);
    });

    test("cloning the sample into an empty free account works", async () => {
      const f = await space();
      const sample = await project(f.ws, { sample: true });
      const id = await cloneProject(d, f.owner, sample, { name: "Mine", language: null });
      expect(await workspaceOf(id)).toBe(f.ws);
      expect(await liveCount(f.ws)).toBe(1);
    });

    test("paid clones are untouched", async () => {
      const f = await space("changemaker");
      const src = await project(f.ws);
      await cloneProject(d, f.owner, src, { name: null, language: null });
      await cloneProject(d, f.owner, src, { name: null, language: null });
      expect(await liveCount(f.ws)).toBe(3);
    });
  });

  describe("move", () => {
    test("moving a legacy project into a free account with a project is refused", async () => {
      const f = await space();
      await project(f.ws);
      const legacy = await project(null, { owner: f.owner });
      await refused(moveProject(d, f.owner, legacy, f.ws), "projects");
      expect(await workspaceOf(legacy)).toBeNull();
    });

    test("moving between two workspaces of one pooled account is allowed", async () => {
      const f = await space();
      const other = await workspace(f.org, f.account, [[f.owner, "owner"]]);
      const p = await project(f.ws);
      await moveProject(d, f.owner, p, other);
      expect(await workspaceOf(p)).toBe(other);
      expect((await liveCount(f.ws)) + (await liveCount(other))).toBe(1);
    });

    test("bulk-moving two legacy projects into an empty free account is refused and moves none", async () => {
      const f = await space();
      const a = await project(null, { owner: f.owner });
      const b = await project(null, { owner: f.owner });
      const detail = await refused(bulkMoveProjects(d, f.owner, [a, b], f.ws), "projects");
      expect(detail.used).toBe(0);
      expect(await workspaceOf(a)).toBeNull();
      expect(await workspaceOf(b)).toBeNull();
    });

    test("a paid target is untouched", async () => {
      const f = await space("changemaker");
      await project(f.ws);
      const a = await project(null, { owner: f.owner });
      const b = await project(null, { owner: f.owner });
      await bulkMoveProjects(d, f.owner, [a, b], f.ws);
      expect(await liveCount(f.ws)).toBe(3);
    });

    test("staff are exempt", async () => {
      const staff = await person(true);
      const f = await space("free", [[staff, "owner"]]);
      await project(f.ws);
      const legacy = await project(null, { owner: staff });
      await moveProject(d, staff, legacy, f.ws);
      expect(await workspaceOf(legacy)).toBe(f.ws);
    });
  });

  describe("recording project", () => {
    const headers = (p: Person) => ({
      "content-type": "application/json",
      "x-app": p.appUserId,
      "x-directus": p.directusUserId,
    });
    const status = (p: Person, id: string) =>
      app.request(`/api/v2/projects/${id}/recording`, { headers: headers(p) });
    const choose = (p: Person, id: string) =>
      app.request(`/api/v2/projects/${id}/recording`, { method: "POST", headers: headers(p) });
    const stored = async (accountId: string) => {
      const [r] = await sql<{ id: string | null }[]>`
        select recording_project_id as id from billing_account where id = ${accountId}`;
      return r?.id ?? null;
    };

    // A free account with an admin, a member, two projects and 600 s used this month.
    async function recordingSpace() {
      const adminP = await person();
      const member = await person();
      const f = await space("free", [
        [adminP, "admin"],
        [member, "member"],
      ]);
      const chosen = await project(f.ws);
      const other = await project(f.ws);
      const sample = await project(f.ws, { sample: true });
      await sql`update billing_account set recording_project_id = ${chosen} where id = ${f.account}`;
      await sql`insert into free_usage (billing_account_id, period_start, key, amount)
        values (${f.account}, '2026-10-01T00:00:00Z', 'audio_seconds', 600)`;
      return { ...f, admin: adminP, member, chosen, other, sample };
    }

    test("status of the recording project", async () => {
      const r = await recordingSpace();
      const res = await status(r.member, r.chosen);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        free: true,
        is_recording_project: true,
        recording_project: { id: r.chosen, name: "P", workspace_id: r.ws },
        can_switch: false,
        file_limit_seconds: 3600,
        audio_seconds_left: 18000 - 600,
      });
    });

    test("status of another project", async () => {
      const r = await recordingSpace();
      const asAdmin = await (await status(r.admin, r.other)).json();
      expect(asAdmin).toMatchObject({
        free: true,
        is_recording_project: false,
        recording_project: { id: r.chosen },
        can_switch: true,
      });
      const asMember = await (await status(r.member, r.other)).json();
      expect(asMember).toMatchObject({ is_recording_project: false, can_switch: false });
      const sample = await (await status(r.admin, r.sample)).json();
      expect(sample).toMatchObject({ is_recording_project: false, can_switch: false });
    });

    test("a pooled client member does not see the recording project", async () => {
      const r = await recordingSpace();
      const client = await person();
      const ownAccount = await account("free", null);
      const clientWs = await workspace(r.org, ownAccount, [[client, "member"]]);
      const mine = await project(clientWs);
      const res = await status(client, mine);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        free: true,
        is_recording_project: false,
        recording_project: { id: null, name: null, workspace_id: null },
        can_switch: false,
      });
    });

    test("a member cannot switch", async () => {
      const r = await recordingSpace();
      expect((await choose(r.member, r.other)).status).toBe(403);
      expect(await stored(r.account)).toBe(r.chosen);
    });

    test("an admin switches", async () => {
      const r = await recordingSpace();
      const res = await choose(r.admin, r.other);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        free: true,
        is_recording_project: true,
        recording_project: { id: r.other },
        can_switch: false,
      });
      expect(await stored(r.account)).toBe(r.other);
      expect(await (await status(r.admin, r.chosen)).json()).toMatchObject({
        is_recording_project: false,
        can_switch: true,
      });
    });

    test("a sample cannot be chosen", async () => {
      const r = await recordingSpace();
      expect((await choose(r.admin, r.sample)).status).toBe(404);
      expect(await stored(r.account)).toBe(r.chosen);
    });

    test("paid status is unlimited and switching is a no-op", async () => {
      const f = await space("changemaker");
      const p = await project(f.ws);
      const unlimited = {
        free: false,
        is_recording_project: true,
        recording_project: null,
        can_switch: false,
        audio_seconds_left: null,
        file_limit_seconds: null,
      };
      expect(await (await status(f.owner, p)).json()).toEqual(unlimited);
      const res = await choose(f.owner, p);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(unlimited);
      expect(await stored(f.account)).toBeNull();
    });
  });
});
