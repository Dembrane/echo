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
import { freeLimitError } from "../src/errors";
import { invalidateFreeLimits } from "../src/limits";
import { accountWorkspaceIds, allowanceSnapshot } from "../src/snapshot";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_snapshot_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");
const OCT = "2026-10-01T00:00:00.000Z";
const NOV = "2026-11-01T00:00:00.000Z";

test("freeLimitError is a 402 naming the limit", () => {
  const e = freeLimitError("report");
  expect(e.status).toBe(402);
  expect(e.code).toBe("billing.tier_limit");
  expect(e.details).toEqual({
    error: "FREE_TIER_LIMIT",
    limit: "report",
    upgrade_cta_tier: "changemaker",
  });
});

test("freeLimitError params never overwrite the reason", () => {
  const e = freeLimitError("chats", { limit: "x", error: "y", used: 2 });
  expect(e.details).toEqual({
    error: "FREE_TIER_LIMIT",
    limit: "chats",
    upgrade_cta_tier: "changemaker",
    used: 2,
  });
});

run("allowance snapshot", () => {
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

  async function resolved(ws: string) {
    const a = await allowanceForWorkspace(db, ws, NOW);
    if (!a) throw new Error("expected a free account");
    return a;
  }

  async function org() {
    const id = randomUUID();
    await sql`insert into org (id, name) values (${id}, 'o')`;
    return id;
  }

  test("paid workspace is not free and has no meters", async () => {
    const o = await org();
    const ws = await workspace(o, await account("paid", o));
    await project(ws);
    expect(await allowanceSnapshot(db, ws, NOW)).toEqual({
      free: false,
      period_start: null,
      resets_at: null,
      audio_seconds: null,
      chats: null,
      reports: null,
      maps: null,
      popcorn_analyses: null,
      projects: null,
    });
  });

  test("free workspace shows ledger usage, limits and live projects", async () => {
    const o = await org();
    const acc = await account("free", o);
    const ws = await workspace(o, acc);
    await project(ws);
    await project(ws, { sample: true });
    await project(ws, { deleted: true });
    await sql`insert into free_usage (billing_account_id, period_start, key, amount) values
      (${acc}, ${OCT}, 'audio_seconds', 3600), (${acc}, ${OCT}, 'chats', 1)`;
    expect(await allowanceSnapshot(db, ws, NOW)).toEqual({
      free: true,
      period_start: OCT,
      resets_at: NOV,
      audio_seconds: { used: 3600, limit: 18000 },
      chats: { used: 1, limit: 2 },
      reports: { used: 0, limit: 1 },
      maps: { used: 0, limit: 1 },
      popcorn_analyses: { used: 0, limit: 12 },
      projects: { used: 1, limit: 1 },
    });
  });

  test("projects count across the pooled org and its free client workspaces", async () => {
    const o = await org();
    const pooled = await account("free", o);
    const internal = await workspace(o, pooled);
    const freeClient = await workspace(o, await account("free", null));
    const paidClient = await workspace(o, await account("paid", null));
    const gone = await workspace(o, pooled, true);
    for (const ws of [internal, freeClient, paidClient, gone]) await project(ws);
    const want = [internal, freeClient].sort();
    expect([...(await accountWorkspaceIds(db, await resolved(internal)))].sort()).toEqual(want);
    const snap = await allowanceSnapshot(db, freeClient, NOW);
    expect(snap.projects).toEqual({ used: 2, limit: 1 });
  });

  test("a free client of a paid org counts only its own workspace", async () => {
    const o = await org();
    await account("paid", o);
    const own = await account("free", null);
    const client = await workspace(o, own);
    await project(client);
    expect(await accountWorkspaceIds(db, await resolved(client))).toEqual([client]);
    expect((await allowanceSnapshot(db, client, NOW)).projects).toEqual({ used: 1, limit: 1 });
  });
});
