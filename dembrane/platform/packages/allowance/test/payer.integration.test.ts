import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { allowanceForProject } from "../src/account";
import { payingAccountsForProjects, payingAccountsForWorkspaces } from "../src/payer";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_payer_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

run("paying account", () => {
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

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function account(
    tier: string,
    scope: { org_id?: string; workspace_id?: string },
    downgradedAt: string | null = null,
  ) {
    const id = randomUUID();
    await sql`insert into billing_account (id, tier, org_id, workspace_id, downgraded_at)
      values (${id}, ${tier}, ${scope.org_id ?? null}, ${scope.workspace_id ?? null}, ${downgradedAt})`;
    return id;
  }

  async function workspace(orgId: string, accountId: string) {
    const id = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${id}, 'w', ${orgId}, ${accountId})`;
    return id;
  }

  async function project(workspaceId: string | null, sample = false) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample)
      values (${id}, true, ${workspaceId}, ${sample})`;
    return id;
  }

  // Org with a pooled account, an internal workspace, and a client workspace on its own account.
  async function seed(orgTier: string, clientTier: string, downgradedAt: string | null = null) {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    const pooled = await account(orgTier, { org_id: orgId }, downgradedAt);
    const internal = await workspace(orgId, pooled);
    const own = await account(clientTier, {});
    const client = await workspace(orgId, own);
    await sql`update billing_account set workspace_id = ${client} where id = ${own}`;
    return { orgId, pooled, internal, own, client };
  }

  test("a paid workspace's project pays from its own account", async () => {
    const s = await seed("paid", "paid");
    const p = await project(s.internal);
    const want = { accountId: s.pooled, tier: "paid", downgradedAt: null, counted: true };
    expect((await payingAccountsForProjects(db, [p])).get(p)).toEqual(want);
    expect((await payingAccountsForWorkspaces(db, [s.internal])).get(s.internal)).toEqual(want);
    const client = await project(s.client);
    expect((await payingAccountsForProjects(db, [client])).get(client)).toEqual({
      ...want,
      accountId: s.own,
    });
  });

  test("a free client workspace pools into the free org account", async () => {
    const s = await seed("free", "free", "2026-10-20T12:00:00Z");
    const p = await project(s.client);
    const want = {
      accountId: s.pooled,
      tier: "free",
      downgradedAt: "2026-10-20T12:00:00.000000Z",
      counted: true,
    };
    expect((await payingAccountsForProjects(db, [p])).get(p)).toEqual(want);
    expect((await payingAccountsForWorkspaces(db, [s.client])).get(s.client)).toEqual(want);
    expect((await allowanceForProject(db, p, NOW))?.accountId).toBe(s.pooled);
  });

  test("a free client workspace of a paid org pays from its own account", async () => {
    const s = await seed("paid", "free");
    const p = await project(s.client);
    const want = { accountId: s.own, tier: "free", downgradedAt: null, counted: true };
    expect((await payingAccountsForProjects(db, [p])).get(p)).toEqual(want);
    expect((await payingAccountsForWorkspaces(db, [s.client])).get(s.client)).toEqual(want);
  });

  test("a paid client workspace of a free org pays from its own account", async () => {
    const s = await seed("free", "paid");
    const got = (await payingAccountsForWorkspaces(db, [s.client])).get(s.client);
    expect(got?.accountId).toBe(s.own);
    expect(got?.tier).toBe("paid");
  });

  test("a sample project is recorded but not counted", async () => {
    const s = await seed("free", "free");
    const p = await project(s.internal, true);
    expect((await payingAccountsForProjects(db, [p])).get(p)).toEqual({
      accountId: s.pooled,
      tier: "free",
      downgradedAt: null,
      counted: false,
    });
  });

  test("unknown, invalid and workspaceless ids are absent", async () => {
    const s = await seed("free", "free");
    const orphan = await project(null);
    const live = await project(s.internal);
    const got = await payingAccountsForProjects(db, [randomUUID(), "not-a-uuid", orphan, live]);
    expect([...got.keys()]).toEqual([live]);
    const ws = await payingAccountsForWorkspaces(db, [randomUUID(), "nope", s.client]);
    expect([...ws.keys()]).toEqual([s.client]);
    expect((await payingAccountsForProjects(db, [])).size).toBe(0);
    expect((await payingAccountsForWorkspaces(db, ["not-a-uuid"])).size).toBe(0);
  });

  test("soft-deleted projects and workspaces still resolve", async () => {
    const s = await seed("free", "free");
    const deleted = await project(s.client);
    await sql`update project set deleted_at = now() where id = ${deleted}`;
    const gone = await seed("paid", "paid");
    const inGone = await project(gone.internal);
    await sql`update workspace set deleted_at = now() where id = ${gone.internal}`;
    const got = await payingAccountsForProjects(db, [deleted, inGone]);
    expect(got.get(deleted)?.accountId).toBe(s.pooled);
    expect(got.get(inGone)?.accountId).toBe(gone.pooled);
    const ws = await payingAccountsForWorkspaces(db, [gone.internal]);
    expect(ws.get(gone.internal)?.accountId).toBe(gone.pooled);
  });

  test("three projects resolve in one call", async () => {
    const free = await seed("free", "free");
    const paid = await seed("paid", "free");
    const a = await project(free.client);
    const b = await project(paid.client);
    const c = await project(paid.internal, true);
    const got = await payingAccountsForProjects(db, [a, b, c, a]);
    expect(got.size).toBe(3);
    expect(got.get(a)?.accountId).toBe(free.pooled);
    expect(got.get(b)?.accountId).toBe(paid.own);
    expect(got.get(c)).toEqual({
      accountId: paid.pooled,
      tier: "paid",
      downgradedAt: null,
      counted: false,
    });
  });
});
