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
import { PaymentRequiredError } from "@dembrane/core";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { allowanceForProject } from "../src/account";
import {
  AI_SPEND_KEY,
  aiBudgetForProject,
  aiBudgetForWorkspace,
  requireAiBudget,
  requireAiBudgetForWorkspace,
} from "../src/budget";
import { add } from "../src/ledger";
import { invalidateFreeLimits, setFreeLimit } from "../src/limits";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_budget_${process.pid}`;
const NOW = new Date("2026-10-25T12:00:00Z");
const OCT = "2026-10-01T00:00:00Z";
const NOV_ISO = "2026-11-01T00:00:00.000Z";

run("ai budget", () => {
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
    const made = createDb({ url, poolMax: 10 });
    db = made.db;
    close = made.close;
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  beforeEach(() => invalidateFreeLimits());

  async function account(tier: string, orgId: string | null, downgradedAt: string | null = null) {
    const id = randomUUID();
    await sql`insert into billing_account (id, tier, org_id, downgraded_at)
      values (${id}, ${tier}, ${orgId}, ${downgradedAt})`;
    return id;
  }

  async function workspace(orgId: string, accountId: string) {
    const id = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${id}, 'w', ${orgId}, ${accountId})`;
    return id;
  }

  async function project(workspaceId: string, isSample = false) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample)
      values (${id}, true, ${workspaceId}, ${isSample})`;
    return id;
  }

  async function seed(tier = "free", downgradedAt: string | null = null) {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    const accountId = await account(tier, orgId, downgradedAt);
    const ws = await workspace(orgId, accountId);
    return { orgId, accountId, ws, project: await project(ws) };
  }

  async function spend(accountId: string, amount: number, period = OCT) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${accountId}, ${period}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  }

  test("the spend key is the one the recorder writes", () => {
    expect(AI_SPEND_KEY).toBe("ai_spend_micro_eur");
  });

  test("passes under the limit and refuses at it", async () => {
    const s = await seed();
    await spend(s.accountId, 4_999_999);
    await requireAiBudget(db, s.project, NOW);
    expect(await aiBudgetForProject(db, s.project, NOW)).toEqual({
      accountId: s.accountId,
      limitMicroEur: 5_000_000,
      spentMicroEur: 4_999_999,
      enforced: true,
      exhausted: false,
      percentUsed: 99,
      resetsAt: new Date(NOV_ISO),
    });

    await spend(s.accountId, 5_000_000);
    const err = await refusal(requireAiBudget(db, s.project, NOW));
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as PaymentRequiredError).details).toEqual({
      used: 5_000_000,
      cap: 5_000_000,
      percent: 100,
      resets_at: NOV_ISO,
      error: "FREE_TIER_LIMIT",
      limit: "ai_budget",
      upgrade_cta_tier: "changemaker",
    });
    const ws = await refusal(requireAiBudgetForWorkspace(db, s.ws, NOW));
    expect((ws as PaymentRequiredError).details).toMatchObject({ limit: "ai_budget" });
  });

  test("no spend row reads as zero", async () => {
    const s = await seed();
    const b = await aiBudgetForWorkspace(db, s.ws, NOW);
    expect(b).toMatchObject({ spentMicroEur: 0, percentUsed: 0, exhausted: false });
  });

  test("percent is floored and capped at 100", async () => {
    const s = await seed();
    await spend(s.accountId, 2_500_000);
    expect((await aiBudgetForProject(db, s.project, NOW))?.percentUsed).toBe(50);
    await spend(s.accountId, 12_000_000);
    expect((await aiBudgetForProject(db, s.project, NOW))?.percentUsed).toBe(100);
  });

  test("paid, sample and unknown projects have no budget and never refuse", async () => {
    const paid = await seed("paid");
    await spend(paid.accountId, 50_000_000);
    expect(await aiBudgetForProject(db, paid.project, NOW)).toBeNull();
    expect(await aiBudgetForWorkspace(db, paid.ws, NOW)).toBeNull();
    await requireAiBudget(db, paid.project, NOW);
    await requireAiBudgetForWorkspace(db, paid.ws, NOW);

    const free = await seed();
    await spend(free.accountId, 50_000_000);
    const sample = await project(free.ws, true);
    expect(await aiBudgetForProject(db, sample, NOW)).toBeNull();
    await requireAiBudget(db, sample, NOW);

    expect(await aiBudgetForProject(db, randomUUID(), NOW)).toBeNull();
    expect(await aiBudgetForWorkspace(db, "not-a-uuid", NOW)).toBeNull();
    await requireAiBudget(db, randomUUID(), NOW);
  });

  test("the staff off switch stops enforcing", async () => {
    const s = await seed();
    await spend(s.accountId, 10_000_000);
    try {
      await setFreeLimit(db, "ai_budget_enforce", 0, null);
      expect(await aiBudgetForProject(db, s.project, NOW)).toMatchObject({
        limitMicroEur: 5_000_000,
        spentMicroEur: 10_000_000,
        enforced: false,
        exhausted: false,
        percentUsed: 100,
      });
      await requireAiBudget(db, s.project, NOW);
      await requireAiBudgetForWorkspace(db, s.ws, NOW);
    } finally {
      await setFreeLimit(db, "ai_budget_enforce", 1, null);
    }
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("the staff default limit applies", async () => {
    const s = await seed();
    await spend(s.accountId, 6_000_000);
    try {
      await setFreeLimit(db, "ai_budget_micro_eur", 7_000_000, null);
      await requireAiBudget(db, s.project, NOW);
      expect((await aiBudgetForProject(db, s.project, NOW))?.limitMicroEur).toBe(7_000_000);
    } finally {
      await setFreeLimit(db, "ai_budget_micro_eur", 5_000_000, null);
    }
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("an override raises the limit until its end date", async () => {
    const s = await seed();
    await spend(s.accountId, 6_000_000);
    await sql`update billing_account set ai_budget_micro_eur = 20000000 where id = ${s.accountId}`;
    await requireAiBudget(db, s.project, NOW);
    expect((await aiBudgetForProject(db, s.project, NOW))?.limitMicroEur).toBe(20_000_000);

    await sql`update billing_account set ai_budget_until = '2026-10-26T00:00:00Z' where id = ${s.accountId}`;
    await requireAiBudget(db, s.project, NOW);

    await sql`update billing_account set ai_budget_until = '2026-10-24T12:00:00Z' where id = ${s.accountId}`;
    expect((await aiBudgetForProject(db, s.project, NOW))?.limitMicroEur).toBe(5_000_000);
    const err = await refusal(requireAiBudget(db, s.project, NOW));
    expect((err as PaymentRequiredError).details).toMatchObject({ cap: 5_000_000 });
  });

  test("an override that ended this morning is back on the default at once", async () => {
    const s = await seed();
    await spend(s.accountId, 6_000_000);
    await sql`update billing_account set ai_budget_micro_eur = 20000000,
      ai_budget_until = '2026-10-25T08:00:00Z' where id = ${s.accountId}`;
    const before = new Date("2026-10-25T07:59:59Z");
    await requireAiBudget(db, s.project, before);
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("an override can lower the limit", async () => {
    const s = await seed();
    await spend(s.accountId, 1_000_000);
    await sql`update billing_account set ai_budget_micro_eur = 1000000 where id = ${s.accountId}`;
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("unlimited has no limit and never refuses, until its end date", async () => {
    const s = await seed();
    await spend(s.accountId, 90_000_000);
    await sql`update billing_account set ai_budget_unlimited = true, ai_budget_micro_eur = 1
      where id = ${s.accountId}`;
    expect(await aiBudgetForProject(db, s.project, NOW)).toMatchObject({
      limitMicroEur: null,
      spentMicroEur: 90_000_000,
      enforced: true,
      exhausted: false,
      percentUsed: 0,
    });
    await requireAiBudget(db, s.project, NOW);

    await sql`update billing_account set ai_budget_until = '2026-10-25T08:00:00Z',
      ai_budget_micro_eur = null where id = ${s.accountId}`;
    expect((await aiBudgetForProject(db, s.project, NOW))?.limitMicroEur).toBe(5_000_000);
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("a pooled client workspace reads the organisation account", async () => {
    const s = await seed();
    const own = await account("free", null);
    const client = await workspace(s.orgId, own);
    await sql`update billing_account set workspace_id = ${client} where id = ${own}`;
    const p = await project(client);
    // The client's own account has room and an override; neither counts.
    await sql`update billing_account set ai_budget_unlimited = true where id = ${own}`;
    await spend(s.accountId, 5_000_000);

    expect((await aiBudgetForWorkspace(db, client, NOW))?.accountId).toBe(s.accountId);
    expect(await aiBudgetForProject(db, p, NOW)).toMatchObject({
      accountId: s.accountId,
      spentMicroEur: 5_000_000,
      exhausted: true,
    });
    expect(await refusal(requireAiBudget(db, p, NOW))).toBeInstanceOf(PaymentRequiredError);
    expect(await refusal(requireAiBudgetForWorkspace(db, client, NOW))).toBeInstanceOf(
      PaymentRequiredError,
    );

    await sql`update billing_account set ai_budget_micro_eur = 20000000 where id = ${s.accountId}`;
    await requireAiBudget(db, p, NOW);
    await requireAiBudgetForWorkspace(db, client, NOW);
  });

  test("spend from an earlier period is ignored", async () => {
    const s = await seed();
    await spend(s.accountId, 9_000_000, "2026-09-01T00:00:00Z");
    expect((await aiBudgetForProject(db, s.project, NOW))?.spentMicroEur).toBe(0);
    await requireAiBudget(db, s.project, NOW);
  });

  test("a downgraded account's period starts at the downgrade", async () => {
    const downgraded = "2026-10-10T09:30:00Z";
    const s = await seed("free", downgraded);
    // Spend while still paid this month sits on the 1st's row and does not count.
    await spend(s.accountId, 9_000_000, OCT);
    expect((await aiBudgetForProject(db, s.project, NOW))?.spentMicroEur).toBe(0);
    await requireAiBudget(db, s.project, NOW);
    await spend(s.accountId, 5_000_000, downgraded);
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });

  test("two calls at once at 4,999,999 both pass, take no lock, and the next refuses", async () => {
    const s = await seed();
    await spend(s.accountId, 4_999_999);
    const a = await allowanceForProject(db, s.project, NOW);
    if (!a) throw new Error("free account expected");
    // Hold the account's ledger lock: a check that took it would block here.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`free_usage:${a.accountId}`}))`;
      locked();
      await held;
    });
    await isLocked;
    try {
      const both = Promise.all([
        requireAiBudget(db, s.project, NOW),
        requireAiBudget(db, s.project, NOW),
      ]);
      const timeout = new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 5_000));
      expect(await Promise.race([both.then(() => "passed" as const), timeout])).toBe("passed");
    } finally {
      release();
      await holder;
    }
    // Both calls finish and are recorded: the account ends over the limit.
    await Promise.all([add(db, a, AI_SPEND_KEY, 3_000), add(db, a, AI_SPEND_KEY, 4_000)]);
    const b = await aiBudgetForProject(db, s.project, NOW);
    expect(b).toMatchObject({ spentMicroEur: 5_006_999, exhausted: true, percentUsed: 100 });
    expect(await refusal(requireAiBudget(db, s.project, NOW))).toBeInstanceOf(PaymentRequiredError);
  });
});
