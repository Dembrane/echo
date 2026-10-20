import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { allowanceForWorkspace } from "../src/account";
import { invalidateFreeLimits, setFreeLimit } from "../src/limits";
import { liveProjectCount, requireProjectRoom } from "../src/projects";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_projects_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

run("account projects", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 2 });
    db = made.db;
    close = made.close;
  });

  beforeEach(() => invalidateFreeLimits());

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function account(tier: string, orgId: string | null) {
    const id = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${id}, ${tier}, ${orgId})`;
    return id;
  }

  async function workspace(orgId: string, accountId: string, deleted = false) {
    const id = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id, deleted_at)
      values (${id}, 'w', ${orgId}, ${accountId}, ${deleted ? NOW.toISOString() : null})`;
    return id;
  }

  async function project(workspaceId: string, opts: { sample?: boolean; deleted?: boolean } = {}) {
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample, deleted_at)
      values (${randomUUID()}, true, ${workspaceId}, ${opts.sample ?? false},
        ${opts.deleted ? NOW.toISOString() : null})`;
  }

  // Org with a free pool, an internal workspace, a free client and a paid client.
  async function seed() {
    const o = randomUUID();
    await sql`insert into org (id, name) values (${o}, 'o')`;
    const pool = await account("free", o);
    const internal = await workspace(o, pool);
    const freeClient = await workspace(o, await account("free", null));
    const paidClient = await workspace(o, await account("paid", null));
    const a = await allowanceForWorkspace(db, internal, NOW);
    if (!a) throw new Error("expected a free account");
    return { a, internal, freeClient, paidClient, pool };
  }

  async function reason(p: Promise<unknown>) {
    return p.then(
      () => null,
      (e) => e as { status: number; details: Record<string, unknown> },
    );
  }

  test("counts live non-sample projects across the pooled workspaces", async () => {
    const s = await seed();
    await project(s.internal);
    await project(s.freeClient);
    await project(s.internal, { sample: true });
    await project(s.internal, { deleted: true });
    await project(await workspace(s.a.orgId as string, s.pool, true));
    await project(s.paidClient);
    expect(await liveProjectCount(db, s.a)).toBe(2);
  });

  test("requireProjectRoom allows the first project", async () => {
    const s = await seed();
    expect(await reason(requireProjectRoom(db, s.a))).toBeNull();
  });

  test("requireProjectRoom refuses the second", async () => {
    const s = await seed();
    await project(s.freeClient);
    const e = await reason(requireProjectRoom(db, s.a));
    expect(e?.status).toBe(402);
    expect(e?.details).toMatchObject({
      error: "FREE_TIER_LIMIT",
      limit: "projects",
      used: 1,
      cap: 1,
    });
  });

  test("incoming counts", async () => {
    const s = await seed();
    const e = await reason(requireProjectRoom(db, s.a, 2));
    expect(e?.details).toMatchObject({ limit: "projects", used: 0, cap: 1 });
  });

  test("a staff limit change applies", async () => {
    const s = await seed();
    await project(s.internal);
    await setFreeLimit(db, "projects", 2, null);
    invalidateFreeLimits();
    try {
      expect(await reason(requireProjectRoom(db, s.a))).toBeNull();
    } finally {
      await setFreeLimit(db, "projects", 1, null);
      invalidateFreeLimits();
    }
  });
});
