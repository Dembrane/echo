import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type postgres from "postgres";
import {
  allowanceForCountedProject,
  allowanceForProject,
  allowanceForWorkspace,
} from "../src/account";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_account_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");
const OCT = new Date("2026-10-01T00:00:00Z");

run("allowance account", () => {
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

  async function project(workspaceId: string | null) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id)
      values (${id}, true, ${workspaceId})`;
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

  test("paid, pioneer, unknown and null tiers are unlimited", async () => {
    for (const tier of ["paid", "pioneer", "enterprise_xl", "FREE"]) {
      const s = await seed(tier, tier);
      expect(await allowanceForWorkspace(db, s.internal, NOW)).toBeNull();
      expect(await allowanceForWorkspace(db, s.client, NOW)).toBeNull();
      expect(await allowanceForProject(db, await project(s.internal), NOW)).toBeNull();
    }
    // tier is NOT NULL in the schema; null here means no row at all.
    expect(await allowanceForWorkspace(db, randomUUID(), NOW)).toBeNull();
    expect(await allowanceForProject(db, randomUUID(), NOW)).toBeNull();
  });

  test("missing billing account is unlimited", async () => {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    const ws = randomUUID();
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into workspace (id, name, org_id, billing_account_id)
        values (${ws}, 'w', ${orgId}, ${randomUUID()})`;
    });
    expect(await allowanceForWorkspace(db, ws, NOW)).toBeNull();
    expect(await allowanceForProject(db, await project(ws), NOW)).toBeNull();
  });

  test("project without workspace is unlimited", async () => {
    expect(await allowanceForProject(db, await project(null), NOW)).toBeNull();
  });

  test("internal free workspace uses the pooled account", async () => {
    const s = await seed("free", "free");
    const want = { accountId: s.pooled, free: true as const, periodStart: OCT, orgId: s.orgId };
    expect(await allowanceForWorkspace(db, s.internal, NOW)).toEqual(want);
    expect(await allowanceForProject(db, await project(s.internal), NOW)).toEqual(want);
  });

  test("free client workspace counts against the free org account", async () => {
    const s = await seed("free", "free");
    const got = await allowanceForWorkspace(db, s.client, NOW);
    expect(got?.accountId).toBe(s.pooled);
    expect(got).toEqual({ accountId: s.pooled, free: true, periodStart: OCT, orgId: s.orgId });
    expect((await allowanceForProject(db, await project(s.client), NOW))?.accountId).toBe(s.pooled);
  });

  test("free client workspace of a paid org uses its own account", async () => {
    const s = await seed("paid", "free");
    expect(await allowanceForWorkspace(db, s.client, NOW)).toEqual({
      accountId: s.own,
      free: true,
      periodStart: OCT,
      orgId: null,
    });
    expect(await allowanceForWorkspace(db, s.internal, NOW)).toBeNull();
  });

  test("paid client workspace of a free org is unlimited", async () => {
    const s = await seed("free", "paid");
    expect(await allowanceForWorkspace(db, s.client, NOW)).toBeNull();
  });

  test("a soft-deleted pooled account is not pooled into", async () => {
    const s = await seed("free", "free");
    await sql`update billing_account set deleted_at = now() where id = ${s.pooled}`;
    expect((await allowanceForWorkspace(db, s.client, NOW))?.accountId).toBe(s.own);
  });

  test("the oldest live pooled account is picked", async () => {
    const s = await seed("free", "free");
    await sql`update billing_account set created_at = '2026-01-01T00:00Z' where id = ${s.pooled}`;
    const newer = await account("paid", { org_id: s.orgId });
    await sql`update billing_account set created_at = '2026-06-01T00:00Z' where id = ${newer}`;
    expect((await allowanceForWorkspace(db, s.client, NOW))?.accountId).toBe(s.pooled);
  });

  test("soft-deleted workspaces and projects still resolve", async () => {
    const s = await seed("free", "free");
    const p = await project(s.client);
    await sql`update workspace set deleted_at = now() where id = ${s.client}`;
    await sql`update project set deleted_at = now() where id = ${p}`;
    expect((await allowanceForWorkspace(db, s.client, NOW))?.accountId).toBe(s.pooled);
    expect((await allowanceForProject(db, p, NOW))?.accountId).toBe(s.pooled);
  });

  test("downgraded this month starts at downgraded_at", async () => {
    const s = await seed("free", "free", "2026-10-20T12:00Z");
    const want = new Date("2026-10-20T12:00:00Z");
    expect((await allowanceForWorkspace(db, s.internal, NOW))?.periodStart).toEqual(want);
    expect((await allowanceForWorkspace(db, s.client, NOW))?.periodStart).toEqual(want);
  });

  test("a malformed id is unlimited", async () => {
    expect(await allowanceForWorkspace(db, "not-a-uuid", NOW)).toBeNull();
    expect(await allowanceForProject(db, "not-a-uuid", NOW)).toBeNull();
  });

  test("counted project: samples and unlimited are null, free non-samples count", async () => {
    const free = await seed("free", "free");
    const counted = await project(free.internal);
    const want = {
      accountId: free.pooled,
      free: true as const,
      periodStart: OCT,
      orgId: free.orgId,
    };
    expect(await allowanceForCountedProject(db, counted, NOW)).toEqual(want);
    const sample = await project(free.internal);
    await sql`update project set is_sample = true where id = ${sample}`;
    expect(await allowanceForProject(db, sample, NOW)).toEqual(want);
    expect(await allowanceForCountedProject(db, sample, NOW)).toBeNull();
    const paid = await seed("paid", "paid");
    expect(await allowanceForCountedProject(db, await project(paid.internal), NOW)).toBeNull();
    expect(await allowanceForCountedProject(db, "not-a-uuid", NOW)).toBeNull();
  });
});
