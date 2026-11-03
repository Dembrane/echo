import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { runSpendRollup } from "../src/jobs";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_rollup_${process.pid}`;

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-03T00:30:00Z");
const DAY = 86_400_000;

run("spend rollup", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;
  let slack: ReturnType<typeof Bun.serve>;
  const posts: string[] = [];
  let slackUrl = "";

  type Row = {
    at: string;
    account: string | null;
    payer: string;
    operation: string | null;
    model?: string;
    input: number | null;
    output: number | null;
    cost: number | null;
  };
  const insert = async (r: Row) => {
    await sql`
      insert into model_call (started_at, service, operation, model_group, model, kind, status, attempt, ms,
        input_tokens, output_tokens, billing_account_id, payer, cost_micro_eur)
      values (${r.at}, 'api', ${r.operation}, 'text', ${r.model ?? "vertex/gemini-3.8-flash"}, 'text', 'ok', 1, 10,
        ${r.input}, ${r.output}, ${r.account}, ${r.payer}, ${r.cost})`;
  };
  const daily = () =>
    sql`
      select day::text, billing_account_id, payer, operation, model, calls, input_tokens::int,
        output_tokens::int, cost_micro_eur::int
      from ai_spend_daily where model <> 'seed'
      order by day, billing_account_id nulls last, payer, operation, model`;
  // A day an earlier run already totalled, so only the 3-day window rolls it up again.
  const totalled = (day: string) =>
    sql`insert into ai_spend_daily (day, model, calls, input_tokens, output_tokens, cost_micro_eur)
        values (${day}, 'seed', 0, 0, 0, 0)`;
  const rollup = (now = NOW) =>
    runSpendRollup({ db: db.db, logger, slackUrl, now: () => now, batch: 2 });

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 1, onnotice: () => {} });
    db = createDb({ url, poolMax: 2 });
    slack = Bun.serve({
      port: 0,
      fetch: async (req) => {
        posts.push(((await req.json()) as { text: string }).text);
        return new Response("ok");
      },
    });
    slackUrl = `http://localhost:${slack.port}/hook`;
  });

  afterAll(async () => {
    slack?.stop(true);
    await sql?.end();
    await db?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  beforeEach(async () => {
    await sql`truncate model_call, ai_spend_daily`;
    posts.length = 0;
  });

  test("yesterday's calls roll up per account, payer, operation and model, and a rerun replaces them", async () => {
    // Yesterday is 2026-11-02 UTC: both edges are in, today and four days back are out.
    await totalled("2026-10-30");
    await insert({
      at: "2026-11-02T00:00:00Z",
      account: A,
      payer: "account",
      operation: "chat.reply",
      input: 100,
      output: 10,
      cost: 1_000,
    });
    await insert({
      at: "2026-11-02T23:59:59.999Z",
      account: A,
      payer: "account",
      operation: "chat.reply",
      input: 200,
      output: null,
      cost: 2_000,
    });
    await insert({
      at: "2026-11-02T12:00:00Z",
      account: B,
      payer: "account",
      operation: "summary",
      input: 50,
      output: 5,
      cost: 500,
    });
    await insert({
      at: "2026-11-02T13:00:00Z",
      account: null,
      payer: "unattributed",
      operation: null,
      input: 7,
      output: 3,
      cost: 70,
    });
    await insert({
      at: "2026-11-02T14:00:00Z",
      account: null,
      payer: "internal",
      operation: null,
      input: 4,
      output: 4,
      cost: 40,
    });
    await insert({
      at: "2026-11-03T00:00:00Z",
      account: A,
      payer: "account",
      operation: "chat.reply",
      input: 999,
      output: 999,
      cost: 999,
    });
    await insert({
      at: "2026-10-30T23:59:59Z",
      account: A,
      payer: "account",
      operation: "chat.reply",
      input: 999,
      output: 999,
      cost: 999,
    });

    const first = await rollup();
    expect(first.rolledUp).toBe(4);
    const expected = [
      {
        day: "2026-11-02",
        billing_account_id: A,
        payer: "account",
        operation: "chat.reply",
        model: "vertex/gemini-3.8-flash",
        calls: 2,
        input_tokens: 300,
        output_tokens: 10,
        cost_micro_eur: 3_000,
      },
      {
        day: "2026-11-02",
        billing_account_id: B,
        payer: "account",
        operation: "summary",
        model: "vertex/gemini-3.8-flash",
        calls: 1,
        input_tokens: 50,
        output_tokens: 5,
        cost_micro_eur: 500,
      },
      {
        day: "2026-11-02",
        billing_account_id: null,
        payer: "internal",
        operation: "",
        model: "vertex/gemini-3.8-flash",
        calls: 1,
        input_tokens: 4,
        output_tokens: 4,
        cost_micro_eur: 40,
      },
      {
        day: "2026-11-02",
        billing_account_id: null,
        payer: "unattributed",
        operation: "",
        model: "vertex/gemini-3.8-flash",
        calls: 1,
        input_tokens: 7,
        output_tokens: 3,
        cost_micro_eur: 70,
      },
    ];
    expect([...(await daily())]).toEqual(expected);

    // A late row then a rerun: the day's totals are replaced, never added to.
    await insert({
      at: "2026-11-02T18:00:00Z",
      account: B,
      payer: "account",
      operation: "summary",
      input: 1,
      output: 1,
      cost: 1,
    });
    await rollup();
    await rollup();
    const after = [...(await daily())];
    expect(after).toHaveLength(4);
    expect(after[1]).toMatchObject({
      calls: 2,
      input_tokens: 51,
      output_tokens: 6,
      cost_micro_eur: 501,
    });
    expect(after[0]).toEqual(expected[0] as never);
  });

  test("a missed day is filled by the next run, which covers the last three complete days", async () => {
    const row = (at: string, cost: number) => ({
      at,
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost,
    });
    await totalled("2026-10-30");
    await insert(row("2026-10-30T23:59:59Z", 1));
    await insert(row("2026-10-31T00:00:00Z", 2));
    await insert(row("2026-11-01T12:00:00Z", 3));
    await insert(row("2026-11-02T12:00:00Z", 4));
    // The run on 2026-11-02 never happened; the next one still fills 2026-11-01.
    const r = await rollup();
    expect(r.rolledUp).toBe(3);
    expect((await daily()).map((d) => [d.day, d.cost_micro_eur])).toEqual([
      ["2026-10-31", 2],
      ["2026-11-01", 3],
      ["2026-11-02", 4],
    ]);
  });

  test("the first run totals every older day before pruning, and later runs use the 3-day window", async () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
    const row = (days: number, cost: number) => ({
      at: at(days),
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost,
    });
    await insert(row(100, 7));
    await insert(row(40, 9));

    const first = await rollup();
    expect(first.rolledUp).toBe(2);
    expect(first.deleted).toBe(1);
    expect((await daily()).map((d) => [d.day, d.cost_micro_eur])).toEqual([
      [at(100).slice(0, 10), 7],
      [at(40).slice(0, 10), 9],
    ]);

    const second = await rollup();
    expect(second.rolledUp).toBe(0);
    expect(second.deleted).toBe(0);
    expect(await daily()).toHaveLength(2);
  });

  test("rows older than 90 days are deleted in batches, newer ones kept", async () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
    for (let i = 0; i < 5; i++)
      await insert({
        at: at(100 + i),
        account: A,
        payer: "account",
        operation: "x",
        input: 1,
        output: 1,
        cost: 1,
      });
    await insert({
      at: at(10),
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost: 1,
    });
    await insert({
      at: at(89),
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost: 1,
    });

    const r = await rollup();
    expect(r.deleted).toBe(5);
    const left = await sql<{ n: number }[]>`select count(*)::int as n from model_call`;
    expect(left[0]?.n).toBe(2);
    expect((await rollup()).deleted).toBe(0);
  });

  test("an unattributed share above 1% posts one Slack text", async () => {
    await insert({
      at: "2026-11-02T10:00:00Z",
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost: 4_900_000,
    });
    await insert({
      at: "2026-11-02T10:00:00Z",
      account: null,
      payer: "unattributed",
      operation: null,
      input: 1,
      output: 1,
      cost: 100_000,
    });

    const r = await rollup();
    expect(r.unattributedShare).toBeCloseTo(0.02, 6);
    expect(posts).toEqual([
      "Unattributed AI spend yesterday: 2.0% (EUR 0.10). Check model_call rows with payer 'unattributed'.",
    ]);
    expect(posts[0]).not.toContain("—");
  });

  test("an unattributed share at 0.5% or with no spend posts nothing", async () => {
    expect((await rollup()).unattributedShare).toBe(0);
    await insert({
      at: "2026-11-02T10:00:00Z",
      account: A,
      payer: "account",
      operation: "x",
      input: 1,
      output: 1,
      cost: 9_945_000,
    });
    await insert({
      at: "2026-11-02T10:00:00Z",
      account: null,
      payer: "internal",
      operation: "x",
      input: 1,
      output: 1,
      cost: 1_000_000,
    });
    await insert({
      at: "2026-11-02T10:00:00Z",
      account: null,
      payer: "unattributed",
      operation: null,
      input: 1,
      output: 1,
      cost: 55_000,
    });
    await insert({
      at: "2026-11-01T10:00:00Z",
      account: null,
      payer: "unattributed",
      operation: null,
      input: 1,
      output: 1,
      cost: 9_000_000,
    });

    const r = await rollup();
    expect(r.unattributedShare).toBeCloseTo(0.005, 6);
    expect(posts).toHaveLength(0);
  });
});
