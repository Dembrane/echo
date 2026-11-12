import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AI_SPEND_KEY,
  FREE_LIMIT_DEFAULTS,
  freeLimits,
  invalidateFreeLimits,
  monthStart,
} from "@dembrane/allowance";
import { connect, createDb, migrate } from "@dembrane/db";
import { syncFeatureRules } from "@dembrane/metering";
import type postgres from "postgres";
import { aiCosts } from "../src/ai-costs";

// obs.ai_spend must equal what the staff AI costs panel shows; obs.ai_call_quality counts flags.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_obs_ai_views_${process.pid}`;
const NOW = new Date("2026-10-25T12:00:00Z");
const MONTH_START = "2026-10-01";

run("obs.ai_spend and obs.ai_call_quality", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let account = "";

  async function modelCall(r: {
    at: string;
    account: string | null;
    payer?: string;
    operation: string | null;
    model: string;
    provider: string | null;
    cost: number;
    priceMissing?: boolean;
    usageEstimated?: boolean;
  }) {
    await sql`insert into model_call (started_at, service, operation, model_group, model, kind,
        status, attempt, ms, provider, billing_account_id, payer, cost_micro_eur,
        price_missing, usage_estimated)
      values (${r.at}, 'api', ${r.operation}, 'g', ${r.model}, 'text', 'ok', 1, 10,
        ${r.provider}, ${r.account}, ${r.payer ?? (r.account ? "account" : "unattributed")},
        ${r.cost}, ${r.priceMissing ?? false}, ${r.usageEstimated ?? false})`;
  }

  async function daily(r: {
    day: string;
    operation: string;
    model: string;
    cost: number;
    calls: number;
  }) {
    await sql`insert into ai_spend_daily (day, billing_account_id, payer, operation, model,
        calls, input_tokens, output_tokens, cost_micro_eur)
      values (${r.day}, ${account}, 'account', ${r.operation}, ${r.model}, ${r.calls},
        10, 5, ${r.cost})`;
  }

  async function price(provider: string, model: string) {
    await sql`insert into ai_price (provider, model, currency, source, effective_from)
      values (${provider}, ${model}, 'USD', 'override', '2026-01-01T00:00:00Z')`;
  }

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });

    const org = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'o')`;
    account = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${account}, 'free', ${org})`;

    // flash is priced by one provider, pro by two.
    await price("vertex", "flash");
    await price("vertex", "pro");
    await price("openai", "pro");

    // Two rolled days.
    await daily({
      day: "2026-10-10",
      operation: "conversations.chunk",
      model: "flash",
      cost: 1000,
      calls: 2,
    });
    await daily({
      day: "2026-10-15",
      operation: "POST /api/chats/:chat_id",
      model: "flash",
      cost: 500,
      calls: 1,
    });
    await daily({ day: "2026-10-15", operation: "", model: "pro", cost: 300, calls: 1 });
    // Unpruned calls on a rolled day: not counted again.
    await modelCall({
      at: "2026-10-15T09:00:00Z",
      account,
      operation: "conversations.chunk",
      model: "flash",
      provider: "vertex",
      cost: 7777,
    });
    // Today, live.
    const today = "2026-10-25T10:00:00Z";
    await modelCall({
      at: today,
      account,
      operation: "conversations.chunk",
      model: "flash",
      provider: "vertex",
      cost: 200,
      priceMissing: true,
    });
    await modelCall({
      at: today,
      account,
      operation: "POST /api/chats/:chat_id",
      model: "flash",
      provider: "vertex",
      cost: 100,
      usageEstimated: true,
    });
    await modelCall({
      at: today,
      account,
      operation: null,
      model: "flash",
      provider: null,
      cost: 25,
    });
    await modelCall({
      at: today,
      account,
      operation: "brand.new",
      model: "pro",
      provider: null,
      cost: 50,
    });
    await modelCall({
      at: today,
      account: null,
      payer: "internal",
      operation: "conversations.chunk",
      model: "flash",
      provider: "vertex",
      cost: 40,
    });
    await modelCall({
      at: today,
      account: null,
      payer: "unattributed",
      operation: "conversations.chunk",
      model: "flash",
      provider: "vertex",
      cost: 60,
    });
    await syncFeatureRules(database.db);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const total = async (where = "true") => {
    const [r] =
      await sql`select coalesce(sum(cost_micro_eur), 0)::bigint as cost from obs.ai_spend where ${sql.unsafe(where)}`;
    return Number(r?.cost);
  };

  test("per account and operation the view sums equal the staff API", async () => {
    const view = await aiCosts(database.db, NOW, 0, 5_000_000);
    expect(view.accounts).toHaveLength(1);
    for (const a of view.accounts)
      for (const f of a.by_feature) {
        const [r] =
          await sql`select sum(cost_micro_eur)::bigint as cost, sum(calls)::bigint as calls, min(feature_group) as g, min(feature) as f
          from obs.ai_spend where billing_account_id = ${a.billing_account_id} and operation = ${f.operation} and day >= ${MONTH_START}`;
        expect({ cost: Number(r?.cost), calls: Number(r?.calls), g: r?.g, f: r?.f }).toEqual({
          cost: f.cost_micro_eur,
          calls: f.calls,
          g: f.group,
          f: f.label,
        });
      }
    expect(
      view.accounts[0]?.by_feature.map((f) => [
        f.operation,
        f.cost_micro_eur,
        f.calls,
        f.group,
        f.label,
      ]),
    ).toEqual([
      ["conversations.chunk", 1200, 3, expect.any(String), expect.any(String)],
      ["POST /api/chats/:chat_id", 600, 2, expect.any(String), expect.any(String)],
      ["", 325, 2, "other", "Unlabelled"],
      ["brand.new", 50, 1, "other", "brand.new"],
    ]);
  });

  test("provider, unattributed and internal totals equal the staff API", async () => {
    const view = await aiCosts(database.db, NOW, 0, 5_000_000);
    // Rolled flash has one provider (vertex); rolled pro has two, so unknown.
    expect(view.by_provider).toEqual([
      { provider: "vertex", cost_micro_eur: 1900 },
      { provider: "unknown", cost_micro_eur: 375 },
    ]);
    const byProvider =
      await sql`select provider, sum(cost_micro_eur)::bigint as cost from obs.ai_spend
      where day >= ${MONTH_START} group by provider order by cost desc`;
    expect(
      byProvider.map((r) => ({ provider: r.provider, cost_micro_eur: Number(r.cost) })),
    ).toEqual(view.by_provider);
    expect(view.unattributed_micro_eur).toBe(60);
    expect(view.internal_micro_eur).toBe(40);
    expect(await total("payer = 'unattributed'")).toBe(60);
    expect(await total("payer = 'internal'")).toBe(40);
  });

  test("a rolled day that still has model_call rows is counted once", async () => {
    expect(await total("day = '2026-10-15'")).toBe(800);
    expect(await total("day = '2026-10-10'")).toBe(1000);
    expect(await total("day = '2026-10-25'")).toBe(475);
    expect(await total()).toBe(2275);
  });

  test("with the rules table emptied total cost is unchanged and every row is other", async () => {
    await sql`delete from ai_feature_rule`;
    try {
      expect(await total()).toBe(2275);
      const groups = await sql`select distinct feature_group from obs.ai_spend`;
      expect(groups.map((r) => r.feature_group)).toEqual(["other"]);
    } finally {
      await syncFeatureRules(database.db);
    }
  });

  test("ai_call_quality counts price_missing and usage_estimated per day and model", async () => {
    const rows =
      await sql`select day::text as day, model, calls::int as calls, price_missing_calls::int as pm, usage_estimated_calls::int as ue
      from obs.ai_call_quality where day = '2026-10-25' order by model`;
    expect([...rows]).toEqual([
      { day: "2026-10-25", model: "flash", calls: 5, pm: 1, ue: 1 },
      { day: "2026-10-25", model: "pro", calls: 1, pm: 0, ue: 0 },
    ]);
  });
});

run("obs.ai_accounts", () => {
  setDefaultTimeout(60_000);
  const name = `staff_obs_ai_accounts_${process.pid}`;
  // Distinct from the code default, so reading tier_limit shows.
  const DEFAULT = 4_000_000;
  const limitDefault = async () => {
    invalidateFreeLimits();
    return (await freeLimits(database.db)).ai_budget_micro_eur;
  };
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.unsafe(`create database ${name}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    await sql`update tier_limit set value = ${DEFAULT} where tier = 'free' and key = 'ai_budget_micro_eur'`;

    const now = new Date();
    const start = monthStart(now);
    const day = start.toISOString().slice(0, 10);
    const downgraded = new Date(
      start.getTime() + Math.floor((now.getTime() - start.getTime()) / 2),
    );
    const past = "2020-01-01T00:00:00Z";
    const future = "2099-01-01T00:00:00Z";

    async function account(
      key: string,
      o: {
        tier?: string;
        org?: string;
        amount?: number;
        unlimited?: boolean;
        until?: string;
        downgradedAt?: Date;
        deleted?: boolean;
        spend?: boolean;
        used?: number;
        usedPeriod?: Date;
      },
    ) {
      const id = randomUUID();
      ids[key] = id;
      const orgId = randomUUID();
      await sql`insert into org (id, name) values (${orgId}, ${o.org ?? key})`;
      await sql`insert into billing_account (id, tier, org_id, ai_budget_micro_eur, ai_budget_unlimited,
          ai_budget_until, downgraded_at, deleted_at)
        values (${id}, ${o.tier ?? "free"}, ${orgId}, ${o.amount ?? null}, ${o.unlimited ?? false},
          ${o.until ?? null}, ${o.downgradedAt?.toISOString() ?? null},
          ${o.deleted ? past : null})`;
      if (o.spend !== false)
        await sql`insert into ai_spend_daily (day, billing_account_id, payer, operation, model,
            calls, input_tokens, output_tokens, cost_micro_eur)
          values (${day}, ${id}, 'account', 'conversations.chunk', 'flash', 1, 10, 5, 1000)`;
      if (o.used !== undefined)
        await sql`insert into free_usage (billing_account_id, period_start, key, amount)
          values (${id}, ${(o.usedPeriod ?? start).toISOString()}, ${AI_SPEND_KEY}, ${o.used})`;
    }

    await account("default", { used: 1_250_000 });
    await account("override", { amount: 2_000_000, until: future, used: 500_000 });
    await account("expired", { amount: 1_000_000, until: past, used: 600_000 });
    await account("unlimited", { unlimited: true, used: 9_000_000 });
    await account("downgraded", {
      downgradedAt: downgraded,
      used: 2_500_000,
      usedPeriod: downgraded,
    });
    await account("zero", { amount: 0, used: 0 });
    await account("paid", { tier: "pro", used: 100 });
    await account("nousage", {});
    await account("emailed", { org: "jane@example.com team", used: 10 });
    await account("deleted", { deleted: true, used: 3_000_000 });
    await account("quiet", { amount: 3_000_000, spend: false });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  const read = async (id: string) => {
    const [r] = await sql`select * from obs.ai_accounts where billing_account_id = ${id}`;
    return r;
  };

  test("every account the staff API returns has the same budget, percent and flags", async () => {
    const view = await aiCosts(database.db, new Date(), 0, await limitDefault());
    expect(view.accounts).toHaveLength(Object.keys(ids).length - 1);
    for (const a of view.accounts) {
      const row = await read(a.billing_account_id);
      expect({
        budget: row?.budget_micro_eur === null ? null : Number(row?.budget_micro_eur),
        custom: row?.custom_budget,
        percent: row?.percent_used,
        unlimited: row?.unlimited,
        deleted: row?.deleted,
        tier: row?.tier,
        scope: row?.account_scope,
        until: (row?.override_until as Date | null)?.toISOString() ?? null,
      }).toEqual({
        budget: a.budget_micro_eur,
        custom: a.custom_budget,
        percent: a.percent_used,
        unlimited: a.unlimited,
        deleted: a.deleted,
        tier: a.tier,
        scope: a.account_scope,
        until: a.override_until,
      });
    }
  });

  test("the seeded cases come out as expected", async () => {
    const pick = async (k: string) => {
      const r = await read(ids[k] as string);
      return [r?.budget_micro_eur, r?.percent_used, r?.period_spend_micro_eur].map((v) =>
        v === null ? null : Number(v),
      );
    };
    expect(await pick("default")).toEqual([DEFAULT, 31, 1_250_000]);
    expect(await pick("override")).toEqual([2_000_000, 25, 500_000]);
    expect(await pick("expired")).toEqual([DEFAULT, 15, 600_000]);
    expect(await pick("unlimited")).toEqual([null, null, 9_000_000]);
    expect(await pick("downgraded")).toEqual([DEFAULT, 62, 2_500_000]);
    expect(await pick("zero")).toEqual([0, 100, 0]);
    expect(await pick("paid")).toEqual([null, null, 100]);
    expect((await read(ids.downgraded as string))?.period_start.toISOString()).not.toBe(
      monthStart(new Date()).toISOString(),
    );
  });

  test("an account with no free_usage row is at 0 percent", async () => {
    const r = await read(ids.nousage as string);
    expect([
      Number(r?.budget_micro_eur),
      r?.percent_used,
      Number(r?.period_spend_micro_eur),
    ]).toEqual([DEFAULT, 0, 0]);
  });

  test("with the tier_limit row gone the budget is the code default, in the view and the API", async () => {
    await sql`delete from tier_limit where tier = 'free' and key = 'ai_budget_micro_eur'`;
    try {
      const fallback = await limitDefault();
      expect(fallback).toBe(FREE_LIMIT_DEFAULTS.ai_budget_micro_eur);
      expect(fallback).not.toBe(DEFAULT);
      expect(Number((await read(ids.default as string))?.budget_micro_eur)).toBe(fallback);
      const view = await aiCosts(database.db, new Date(), 0, fallback);
      for (const a of view.accounts) {
        const row = await read(a.billing_account_id);
        expect([
          row?.budget_micro_eur === null ? null : Number(row?.budget_micro_eur),
          row?.percent_used,
        ]).toEqual([a.budget_micro_eur, a.percent_used]);
      }
    } finally {
      await sql`insert into tier_limit (tier, key, value) values ('free', 'ai_budget_micro_eur', ${DEFAULT})
        on conflict (tier, key) do update set value = excluded.value`;
      invalidateFreeLimits();
    }
  });

  test("emails in names are withheld", async () => {
    expect((await read(ids.emailed as string))?.name).toBe("[email withheld] team");
  });

  test("an account with only a budget override and no spend is in the view", async () => {
    const r = await read(ids.quiet as string);
    expect(r?.budget_micro_eur).toBe("3000000");
    expect(r?.custom_budget).toBe(true);
    expect(r?.percent_used).toBe(0);
  });
});
