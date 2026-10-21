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
import { sql as q } from "drizzle-orm";
import type postgres from "postgres";
import { type AllowanceAccount, allowanceForWorkspace } from "../src/account";
import { withAllowanceLock } from "../src/ledger";
import { invalidateFreeLimits } from "../src/limits";
import { liveProjectCount, requireProjectRoom } from "../src/projects";

// Adversarial replays against the allowance core. Each test fails while the bypass exists.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_bypass_core_${process.pid}`;

run("allowance core bypasses", () => {
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
    const made = createDb({ url, poolMax: 4 });
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

  async function freeWorkspace(downgradedAt: string | null = null) {
    const o = randomUUID();
    await sql`insert into org (id, name) values (${o}, 'o')`;
    const acc = randomUUID();
    await sql`insert into billing_account (id, tier, org_id, downgraded_at)
      values (${acc}, 'free', ${o}, ${downgradedAt})`;
    const ws = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${o}, ${acc})`;
    return ws;
  }

  // Mirrors tenancy projects.create / projects clone: check the cap and insert under the lock.
  function createProject(
    a: AllowanceAccount,
    workspaceId: string,
    afterCheck: () => Promise<void>,
  ): Promise<void> {
    return withAllowanceLock(db, a, async (tx) => {
      await requireProjectRoom(tx, a);
      await afterCheck();
      await tx.execute(q`insert into project (id, is_conversation_allowed, workspace_id)
        values (${randomUUID()}, true, ${workspaceId})`);
    });
  }

  // Two creates whose request clocks fall in different periods of the same account.
  async function race(ws: string, earlier: Date, later: Date) {
    const a1 = await allowanceForWorkspace(db, ws, earlier);
    const a2 = await allowanceForWorkspace(db, ws, later);
    if (!a1 || !a2) throw new Error("expected a free account");
    expect(a1.accountId).toBe(a2.accountId);
    let firstChecked!: () => void;
    const checked = new Promise<void>((r) => {
      firstChecked = r;
    });
    let secondChecked!: () => void;
    const second = new Promise<void>((r) => {
      secondChecked = r;
    });
    // The first holds its lock until the second has checked too, or 1.5 s pass (one shared lock).
    const p1 = createProject(a1, ws, async () => {
      firstChecked();
      await Promise.race([second, new Promise((r) => setTimeout(r, 1500))]);
    });
    await checked;
    const p2 = createProject(a2, ws, async () => {
      secondChecked();
    });
    const results = await Promise.allSettled([p1, p2]);
    return { a: a1, results };
  }

  // Control: the harness refuses the second create when both share a period (passes today).
  test("control: two creates in the same period get one project", async () => {
    const ws = await freeWorkspace();
    const at = new Date("2026-10-20T10:00:00.000Z");
    const { a, results } = await race(ws, at, at);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await liveProjectCount(db, a)).toBe(1);
  });

  test("project cap holds for two creates straddling midnight UTC on the 1st", async () => {
    const ws = await freeWorkspace();
    const { a, results } = await race(
      ws,
      new Date("2026-10-31T23:59:59.999Z"),
      new Date("2026-11-01T00:00:00.000Z"),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await liveProjectCount(db, a)).toBe(1);
  });

  test("project cap holds for two creates straddling a downgrade stamp", async () => {
    const ws = await freeWorkspace("2026-10-15T12:00:00.000Z");
    const { a, results } = await race(
      ws,
      new Date("2026-10-15T11:59:59.999Z"),
      new Date("2026-10-15T12:00:00.001Z"),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await liveProjectCount(db, a)).toBe(1);
  });
});
