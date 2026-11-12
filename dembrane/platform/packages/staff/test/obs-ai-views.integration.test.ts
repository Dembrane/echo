import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
