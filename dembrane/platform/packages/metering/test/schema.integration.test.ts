import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, migrate } from "@dembrane/db";
import type postgres from "postgres";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_schema_${process.pid}`;

const columns = async (sql: postgres.Sql, table: string) =>
  (
    await sql<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' and table_name = ${table}`
  ).reduce<Record<string, { type: string; nullable: boolean; default: string | null }>>(
    (acc, c) => {
      acc[c.column_name] = {
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        default: c.column_default,
      };
      return acc;
    },
    {},
  );

run("ai spend schema", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("model_call carries provider, payer, token kinds and cost", async () => {
    const c = await columns(sql, "model_call");
    expect(c).toMatchObject({
      provider: { type: "text", nullable: true },
      billing_account_id: { type: "uuid", nullable: true },
      project_id: { type: "uuid", nullable: true },
      payer: { type: "text", nullable: false, default: "'unattributed'::text" },
      counted: { type: "boolean", nullable: false, default: "false" },
      cached_input_tokens: { type: "integer", nullable: true },
      audio_input_tokens: { type: "integer", nullable: true },
      reasoning_tokens: { type: "integer", nullable: true },
      audio_seconds: { type: "real", nullable: true },
      search_queries: { type: "integer", nullable: true },
      usage_estimated: { type: "boolean", nullable: false, default: "false" },
      price_missing: { type: "boolean", nullable: false, default: "false" },
      cost_micro_eur: { type: "bigint", nullable: true },
      price_id: { type: "bigint", nullable: true },
    });
    const idx =
      await sql`select indexdef from pg_indexes where indexname = 'model_call_account_started_idx'`;
    expect(idx[0]?.indexdef).toContain("(billing_account_id, started_at)");
  });

  test("billing_account carries the budget override", async () => {
    expect(await columns(sql, "billing_account")).toMatchObject({
      ai_budget_micro_eur: { type: "bigint", nullable: true },
      ai_budget_unlimited: { type: "boolean", nullable: false, default: "false" },
      ai_budget_until: { type: "timestamp with time zone", nullable: true },
    });
  });

  test("price, fx and daily spend tables exist with their keys", async () => {
    expect(Object.keys(await columns(sql, "ai_price")).sort()).toEqual(
      [
        "id",
        "provider",
        "model",
        "currency",
        "input_per_m",
        "cached_input_per_m",
        "audio_input_per_m",
        "output_per_m",
        "long_context_threshold",
        "long_input_per_m",
        "long_cached_input_per_m",
        "long_output_per_m",
        "per_audio_second",
        "per_search_query",
        "source",
        "effective_from",
      ].sort(),
    );
    expect(await columns(sql, "ai_fx_rate")).toMatchObject({
      day: { type: "date", nullable: false },
      usd_to_eur: { type: "numeric", nullable: false },
      fetched_at: { type: "timestamp with time zone", nullable: false },
    });
    expect(await columns(sql, "ai_spend_daily")).toMatchObject({
      day: { type: "date" },
      billing_account_id: { type: "uuid", nullable: true },
      payer: { type: "text", nullable: false, default: "'unattributed'::text" },
      operation: { type: "text", nullable: false, default: "''::text" },
      model: { type: "text" },
      calls: { type: "integer" },
      input_tokens: { type: "bigint" },
      output_tokens: { type: "bigint" },
      cost_micro_eur: { type: "bigint" },
    });

    await sql`insert into ai_price (provider, model, currency, source, effective_from)
              values ('vertex', 'm', 'USD', 'models.dev', '2026-11-01')`;
    const dupPrice =
      await sql`insert into ai_price (provider, model, currency, source, effective_from)
              values ('vertex', 'm', 'USD', 'override', '2026-11-01') on conflict do nothing returning id`;
    expect(dupPrice).toHaveLength(0);

    // Null-account rows collapse to one row per day, payer, operation and model; payers stay apart.
    const day = async (payer: string) =>
      sql`insert into ai_spend_daily (day, billing_account_id, payer, model, calls, input_tokens, output_tokens, cost_micro_eur)
          values ('2026-11-03', null, ${payer}, 'm', 1, 10, 2, 5) on conflict do nothing returning day`;
    expect(await day("unattributed")).toHaveLength(1);
    expect(await day("unattributed")).toHaveLength(0);
    expect(await day("internal")).toHaveLength(1);
  });

  test("tier_limit has the free budget seeds", async () => {
    const rows = await sql<{ key: string; value: string }[]>`
      select key, value::text from tier_limit
      where tier = 'free' and key in ('ai_budget_micro_eur', 'ai_budget_enforce') order by key`;
    expect([...rows]).toEqual([
      { key: "ai_budget_enforce", value: "1" },
      { key: "ai_budget_micro_eur", value: "5000000" },
    ]);
  });

  test("obs.day_ai_spend answers", async () => {
    const rows = await sql.unsafe("select * from obs.day_ai_spend limit 0");
    expect(rows.columns.map((c) => c.name)).toEqual([
      "day",
      "billing_account_id",
      "payer",
      "operation",
      "model",
      "calls",
      "input_tokens",
      "output_tokens",
      "cost_micro_eur",
    ]);
  });
});
