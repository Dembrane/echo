import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { ModelCall } from "@dembrane/llm";
import { type Payer, payerKey, withPayer } from "@dembrane/observability";
import type postgres from "postgres";
import {
  type ModelCallRecorder,
  modelCallRecorder,
  modelCallTable,
  type PriceRow,
  resolvePayers,
  toRow,
} from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_recorder_${process.pid}`;

// One micro-euro per input token, two per output token.
const FLASH: PriceRow = {
  id: 7,
  provider: "vertex",
  model: "gemini-3.8-flash",
  source: "override",
  effectiveFrom: new Date("2026-10-01T00:00:00Z"),
  currency: "EUR",
  inputPerM: 1,
  cachedInputPerM: null,
  audioInputPerM: null,
  outputPerM: 2,
  longContext: null,
  perAudioSecond: null,
  perSearchQuery: null,
};
const prices = {
  current: () => ({ prices: new Map([["vertex/gemini-3.8-flash", FLASH]]), usdToEur: 1 }),
};

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  group: "multi_modal_pro",
  provider: "vertex",
  model: "gemini-3.8-flash",
  kind: "generate",
  startedAt: new Date("2026-10-14T11:05:00Z"),
  ms: 900,
  inputTokens: 1000,
  cachedInputTokens: null,
  audioInputTokens: null,
  outputTokens: 100,
  reasoningTokens: null,
  audioSeconds: null,
  searchQueries: null,
  usageEstimated: false,
  finishReason: "stop",
  status: "ok",
  error: null,
  attempt: 1,
  fallback: false,
  ...over,
});
const COST = 1200;

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

run("model call recorder against the database", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let recorder: ModelCallRecorder;

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
    recorder = modelCallRecorder({
      sink: modelCallTable(db),
      logger: quiet,
      service: "echo-worker",
      prices,
      flushMs: 60_000,
    });
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function account(tier: string, downgradedAt: string | null = null) {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id, downgraded_at)
      values (${accountId}, ${tier}, ${orgId}, ${downgradedAt})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    return { accountId, workspaceId };
  }

  async function project(workspaceId: string | null, sample = false) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample)
      values (${id}, true, ${workspaceId}, ${sample})`;
    return id;
  }

  const observe = (p: Payer | null, c: ModelCall = call()) =>
    p ? withPayer(p, () => recorder.observe(c)) : recorder.observe(c);

  const rowsOf = (accountId: string | null) =>
    sql<{ payer: string; counted: boolean; project_id: string | null; cost_micro_eur: string }[]>`
      select payer, counted, project_id, cost_micro_eur from model_call
      where billing_account_id is not distinct from ${accountId} order by id`;

  const spendOf = (accountId: string) =>
    sql<{ period_start: Date; amount: string }[]>`
      select period_start, amount from free_usage
      where billing_account_id = ${accountId} and key = 'ai_spend_micro_eur' order by period_start`;

  test("calls in a free project count, a sample project's call is recorded but not counted", async () => {
    const { accountId, workspaceId } = await account("free");
    const free = await project(workspaceId);
    const sample = await project(workspaceId, true);
    observe({ ref: "project", id: free });
    observe({ ref: "project", id: free }, call({ outputTokens: 0 }));
    observe({ ref: "project", id: sample });
    await recorder.flush();
    const rows = await rowsOf(accountId);
    expect(rows.map((r) => [r.payer, r.counted, r.project_id, Number(r.cost_micro_eur)])).toEqual([
      ["account", true, free, COST],
      ["account", true, free, 1000],
      ["account", false, sample, COST],
    ]);
    const spend = await spendOf(accountId);
    expect(spend.map((s) => [s.period_start.toISOString(), Number(s.amount)])).toEqual([
      ["2026-10-01T00:00:00.000Z", COST + 1000],
    ]);
  });

  test("spend adds to what the month already holds", async () => {
    const { accountId, workspaceId } = await account("free");
    const p = await project(workspaceId);
    observe({ ref: "project", id: p });
    await recorder.flush();
    observe({ ref: "project", id: p.toUpperCase() });
    await recorder.flush();
    expect((await spendOf(accountId)).map((s) => Number(s.amount))).toEqual([2 * COST]);
  });

  test("a chat resolves through its project; an internal call pays nobody", async () => {
    const { accountId, workspaceId } = await account("free");
    const p = await project(workspaceId);
    const chat = randomUUID();
    await sql`insert into project_chat (id, project_id) values (${chat}, ${p})`;
    const before = await sql`select count(*)::int as n from free_usage`;
    observe({ ref: "chat", id: chat });
    observe({ internal: "demo_build" });
    await recorder.flush();
    expect((await rowsOf(accountId)).map((r) => [r.payer, r.project_id])).toEqual([["account", p]]);
    const [internal] = await sql<{ payer: string; billing_account_id: string | null }[]>`
      select payer, billing_account_id, counted from model_call where payer = 'internal'`;
    expect(internal).toMatchObject({ payer: "internal", billing_account_id: null, counted: false });
    expect((await spendOf(accountId)).map((s) => Number(s.amount))).toEqual([COST]);
    const after = await sql`select count(*)::int as n from free_usage`;
    expect(after[0]?.n).toBe((before[0]?.n as number) + 1);
  });

  test("a free account downgraded mid-month counts from the downgrade; paid from the 1st", async () => {
    const free = await account("free", "2026-10-14T10:30:00Z");
    const paid = await account("paid");
    const fp = await project(free.workspaceId);
    const pp = await project(paid.workspaceId);
    // 10:05 is before the downgrade, 11:05 after it.
    observe({ ref: "project", id: fp }, call({ startedAt: new Date("2026-10-14T10:05:00Z") }));
    observe({ ref: "project", id: fp }, call({ startedAt: new Date("2026-10-14T11:05:00Z") }));
    observe({ ref: "project", id: pp }, call({ startedAt: new Date("2026-10-14T11:05:00Z") }));
    await recorder.flush();
    expect(
      (await spendOf(free.accountId)).map((s) => [s.period_start.toISOString(), Number(s.amount)]),
    ).toEqual([
      ["2026-10-01T00:00:00.000Z", COST],
      ["2026-10-14T10:30:00.000Z", COST],
    ]);
    expect(
      (await spendOf(paid.accountId)).map((s) => [s.period_start.toISOString(), Number(s.amount)]),
    ).toEqual([["2026-10-01T00:00:00.000Z", COST]]);
  });

  test("a payer that does not resolve keeps its row as unattributed", async () => {
    const before = await sql`select count(*)::int as n from free_usage`;
    const orphan = await project(null);
    const unknown = randomUUID();
    observe({ ref: "project", id: orphan });
    observe({ ref: "conversation", id: unknown });
    observe({ ref: "report", id: "not-a-number" });
    observe(null);
    await recorder.flush();
    const rows = await sql<{ payer: string; billing_account_id: string | null }[]>`
      select payer, billing_account_id from model_call where payer = 'unattributed' order by id`;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.billing_account_id === null)).toBe(true);
    const after = await sql`select count(*)::int as n from free_usage`;
    expect(after[0]?.n).toBe(before[0]?.n as number);
  });

  test("rows and spend are one write: a spend that fails takes its rows back", async () => {
    const { accountId, workspaceId } = await account("free");
    const p = await project(workspaceId);
    const payer: Payer = { ref: "project", id: p };
    const sink = modelCallTable(db);
    const row = { row: toRow(call(), "echo-worker", null, null), payer };
    const bucket = (costMicroEur: number) =>
      new Map([[payerKey(payer), { payer, hour: new Date("2026-10-14T11:00:00Z"), costMicroEur }]]);
    // Past bigint: free_usage refuses it after model_call took the row.
    await expect(sink.write([row], bucket(1e20))).rejects.toThrow(/insert into "free_usage"/);
    expect(await rowsOf(accountId)).toHaveLength(0);
    expect(await spendOf(accountId)).toHaveLength(0);
    await sink.write([row], bucket(500));
    expect(await rowsOf(accountId)).toHaveLength(1);
    expect((await spendOf(accountId)).map((s) => Number(s.amount))).toEqual([500]);
  });

  test("every payer kind resolves to its project's paying account", async () => {
    const { accountId, workspaceId } = await account("free");
    const p = await project(workspaceId);
    const conversation = randomUUID();
    await sql`insert into conversation (id, project_id) values (${conversation}, ${p})`;
    const chat = randomUUID();
    await sql`insert into project_chat (id, project_id) values (${chat}, ${p})`;
    const agentRun = randomUUID();
    await sql`insert into project_agentic_run (id, project_id) values (${agentRun}, ${p})`;
    const [report] = await sql<{ id: string }[]>`
      insert into project_report (project_id) values (${p}) returning id::text`;
    const loop = randomUUID();
    await sql`insert into agent_loop (id, project_id, expires_at)
      values (${loop}, ${p}, now() + interval '1 day')`;
    const artifact = randomUUID();
    await sql`insert into conversation_artifact (id, conversation_id)
      values (${artifact}, ${conversation})`;
    const analysis = randomUUID();
    // Skips the analysis guards, which want a whole recipe and scope behind the run.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into analysis_run (id, project_id, scope_id, definition, idempotency_key,
          mode, recipe_id, recipe_version, request_fingerprint, request_order, status)
        values (${analysis}, ${p}, ${p}, '{}', ${analysis}, 'refresh', 'r', '1', 'f', 1, 'queued')`;
    });
    const payers: Payer[] = [
      { ref: "project", id: p.toUpperCase() },
      { ref: "conversation", id: conversation },
      { ref: "chat", id: chat },
      { ref: "agent_run", id: agentRun },
      { ref: "report", id: report?.id as string },
      { ref: "canvas", id: loop },
      { ref: "popcorn_loop", id: loop.toUpperCase() },
      { ref: "verify_artifact", id: artifact },
      { ref: "analysis_run", id: analysis },
    ];
    const got = await resolvePayers(db, [
      ...payers,
      { ref: "workspace", id: workspaceId },
      { internal: "demo_build" },
      { ref: "chat", id: "nope" },
    ]);
    for (const payer of payers)
      expect([payerKey(payer), got.get(payerKey(payer))]).toEqual([
        payerKey(payer),
        { accountId, tier: "free", downgradedAt: null, counted: true, projectId: p },
      ]);
    expect(got.get(`workspace:${workspaceId}`)).toEqual({
      accountId,
      tier: "free",
      downgradedAt: null,
      counted: true,
      projectId: null,
    });
    expect(got.get("internal:demo_build")).toBe("internal");
    expect(got.get("chat:nope")).toBeNull();
  });
});
