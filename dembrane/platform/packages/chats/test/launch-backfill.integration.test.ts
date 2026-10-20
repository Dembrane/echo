import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import {
  allowanceForProject,
  invalidateFreeLimits,
  monthStart,
  periodStart,
} from "@dembrane/allowance";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { freeChats } from "../src/free";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `chats_launch_backfill_${process.pid}`;
const MIGRATION = new URL(
  "../../db/migrations/0035_expand_free_tier_launch_backfill.sql",
  import.meta.url,
);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const rejection = (p: Promise<unknown>) =>
  Promise.resolve(p).then(
    () => null,
    (e) => e,
  );

run("free tier launch backfill", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const M = monthStart(new Date());
  const at = (ms: number) => new Date(M.getTime() + ms).toISOString();
  const id = () => crypto.randomUUID() as string;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function backfill() {
    const text = readFileSync(MIGRATION, "utf8");
    await sql.unsafe(text.replaceAll("--> statement-breakpoint", ""));
  }

  // An org on a pooled account with an internal workspace, a client workspace on its own free account, and a sample project.
  async function seed(opts: { tier?: string; downgradedAt?: string } = {}) {
    const [org, pooled, internal, own, client, project, clientProject, sample] = [
      id(),
      id(),
      id(),
      id(),
      id(),
      id(),
      id(),
      id(),
    ];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier, downgraded_at, created_at)
      values (${pooled}, ${org}, ${opts.tier ?? "free"}, ${opts.downgradedAt ?? null}, now() - interval '1 year')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${internal}, 'W', ${org}, ${pooled})`;
    await sql`insert into billing_account (id, tier) values (${own}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${client}, 'C', ${org}, ${own})`;
    await sql`update billing_account set workspace_id = ${client} where id = ${own}`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed)
      values (${project}, 'Mine', ${internal}, true), (${clientProject}, 'Client', ${client}, true)`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Sample', ${internal}, false, true)`;
    return { pooled, own, project, clientProject, sample };
  }

  async function conversation(
    projectId: string,
    duration: number,
    createdAt: string,
    deleted = false,
  ) {
    await sql`insert into conversation (id, project_id, duration, created_at, deleted_at)
      values (${id()}, ${projectId}, ${duration}, ${createdAt}, ${deleted ? createdAt : null})`;
  }

  async function chat(projectId: string, turns: string[], deleted = false) {
    const chatId = id();
    await sql`insert into project_chat (id, project_id, deleted_at)
      values (${chatId}, ${projectId}, ${deleted ? new Date().toISOString() : null})`;
    for (const t of turns)
      await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
        values (${id()}, ${chatId}, 'user', 'hi', ${t})`;
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
      values (${id()}, ${chatId}, 'assistant', 'hello', ${turns[0] ?? at(0)})`;
    return chatId;
  }

  async function report(
    projectId: string,
    createdAt: string,
    opts: { kind?: string; status?: string; content?: string } = {},
  ) {
    const [r] = await sql<
      { id: string }[]
    >`insert into project_report (project_id, kind, status, content, date_created)
      values (${projectId}, ${opts.kind ?? "report"}, ${opts.status ?? "published"}, ${opts.content ?? "x"}, ${createdAt})
      returning id`;
    return String(r?.id);
  }

  // A run in the project's arguments scope; the map service uses scope_key 'project'.
  async function mapRun(
    projectId: string,
    createdAt: string,
    opts: { reusedRunId?: string; key?: string } = {},
  ) {
    const runId = id();
    const [scope] = await sql<{ id: string }[]>`
      insert into analysis_scope (id, kind, project_id, recipe_id, scope_key)
      values (${id()}, 'producer', ${projectId}, 'arguments', 'project')
      on conflict (project_id, recipe_id, scope_key) where kind = 'producer'
      do update set next_request_order = analysis_scope.next_request_order + 1
      returning id`;
    const [order] = await sql<{ n: number }[]>`
      select count(*)::int + 1 as n from analysis_run where scope_id = ${scope?.id ?? null}`;
    await sql`insert into analysis_run (id, definition, idempotency_key, mode, project_id, recipe_id,
        recipe_version, request_fingerprint, request_order, scope_id, status, created_at, reused_run_id)
      values (${runId}, '{}'::json, ${opts.key ?? runId}, 'refresh', ${projectId}, 'arguments', '1', ${runId},
        ${order?.n ?? 1}, ${scope?.id ?? null}, 'failed', ${createdAt}, ${opts.reusedRunId ?? null})`;
    return runId;
  }

  async function popcornLoop(projectId: string) {
    const popcorn = await report(projectId, at(0), { kind: "popcorn" });
    const loop = id();
    await sql`insert into agent_loop (id, project_id, report_id, name, expires_at)
      values (${loop}, ${projectId}, ${popcorn}, 'p', now() + interval '1 day')`;
    return { loop, popcorn };
  }

  async function popcornRun(loopId: string, status: string, detail: string, startedAt: string) {
    const runId = id();
    await sql`insert into agent_loop_run (id, loop_id, status, detail, started_at)
      values (${runId}, ${loopId}, ${status}, ${detail}, ${startedAt})`;
    return runId;
  }

  async function usage(accountId: string) {
    const rows = await sql<{ key: string; amount: string; period_start: Date }[]>`
      select key, amount, period_start from free_usage where billing_account_id = ${accountId}`;
    return Object.fromEntries(
      rows.map((r) => [r.key, { amount: Number(r.amount), period: r.period_start.toISOString() }]),
    );
  }

  const stampOf = async (
    table: "project_chat" | "project_report" | "agent_loop_run",
    rowId: string,
  ) => {
    const [r] = await sql<
      { s: Date | null }[]
    >`select free_period_start as s from ${sql(table)} where id = ${rowId}`;
    return r?.s ? r.s.toISOString() : null;
  };

  test("this month's usage is counted per pooled account", async () => {
    const s = await seed();
    await conversation(s.project, 3600, at(MIN), true);
    await conversation(s.clientProject, 1800, at(2 * MIN));
    await conversation(s.project, 7200, at(-DAY));
    await conversation(s.sample, 900, at(3 * MIN));
    await backfill();
    expect(await usage(s.pooled)).toEqual({
      audio_seconds: { amount: 5400, period: M.toISOString() },
    });
    expect(await usage(s.own)).toEqual({});
  });

  test("the two most recently active chats this month are claimed, older ones freeze", async () => {
    const s = await seed();
    // a started last but its latest turn is the oldest of the three.
    const a = await chat(s.project, [at(4 * MIN), at(5 * MIN)]);
    const b = await chat(s.project, [at(MIN), at(6 * MIN)], true);
    const c = await chat(s.clientProject, [at(2 * MIN), at(7 * MIN)]);
    const sampleChat = await chat(s.sample, [at(8 * MIN)]);
    await backfill();
    expect((await usage(s.pooled)).chats?.amount).toBe(2);
    for (const chatId of [b, c])
      expect(await stampOf("project_chat", chatId)).toBe(M.toISOString());
    expect(await stampOf("project_chat", a)).not.toBeNull();
    expect(await stampOf("project_chat", a)).not.toBe(M.toISOString());
    expect(await stampOf("project_chat", sampleChat)).toBeNull();
    const fc = freeChats(database.db);
    expect(await fc.turnStatus(c, s.clientProject, new Date())).toEqual({
      limit: 20,
      used: 2,
      frozen: false,
    });
    expect((await fc.turnStatus(a, s.project, new Date()))?.frozen).toBe(true);
    const err = await rejection(
      fc.admitTurn({
        projectId: s.project,
        chatId: a,
        messageId: id(),
        text: "x",
        now: new Date(),
      }),
    );
    expect(err).toMatchObject({ details: { limit: "chat_turns", reason: "frozen" } });
  });

  test("chats from earlier months are frozen", async () => {
    const s = await seed();
    const first = new Date(M.getTime() - 40 * DAY);
    const turns = [0, 1, 2, 3].map((i) => new Date(first.getTime() + i * MIN).toISOString());
    const old = await chat(s.project, turns);
    await backfill();
    const firstMonth = monthStart(first).toISOString();
    expect(await stampOf("project_chat", old)).toBe(firstMonth);
    expect((await usage(s.pooled)).chats).toBeUndefined();
    const err = await rejection(
      freeChats(database.db).admitTurn({
        projectId: s.project,
        chatId: old,
        messageId: id(),
        text: "again",
        now: new Date(),
      }),
    );
    expect(err).toMatchObject({ details: { limit: "chat_turns" } });
  });

  test("reports, maps and popcorn are counted", async () => {
    const s = await seed();
    const counted = await report(s.project, at(MIN));
    const errored = await report(s.project, at(2 * MIN), { status: "error", content: "" });
    const lastMonth = await report(s.project, at(-DAY));
    const sampleReport = await report(s.sample, at(MIN));
    const first = await mapRun(s.project, at(MIN));
    await mapRun(s.project, at(2 * MIN));
    await mapRun(s.project, at(3 * MIN), { reusedRunId: first });
    // A dependency run the executor made for another recipe's plan.
    await mapRun(s.project, at(3 * MIN), { key: `auto:${id()}:arguments@project` });
    await mapRun(s.sample, at(3 * MIN));
    const { loop, popcorn } = await popcornLoop(s.project);
    const r1 = await popcornRun(loop, "ok", "run 1: 3 notes", at(MIN));
    const r2 = await popcornRun(loop, "ok", "run 2: 1 note", at(2 * MIN));
    const translated = await popcornRun(loop, "ok", "translated to nl", at(3 * MIN));
    const failed = await popcornRun(loop, "error", "run 3: boom", at(4 * MIN));
    await backfill();
    const u = await usage(s.pooled);
    expect([u.reports?.amount, u.maps?.amount, u.popcorn_analyses?.amount]).toEqual([1, 2, 2]);
    expect(await stampOf("project_report", counted)).toBe(M.toISOString());
    for (const r of [errored, lastMonth, sampleReport, popcorn])
      expect(await stampOf("project_report", r)).toBeNull();
    for (const r of [r1, r2]) expect(await stampOf("agent_loop_run", r)).toBe(M.toISOString());
    for (const r of [translated, failed]) expect(await stampOf("agent_loop_run", r)).toBeNull();
  });

  // A downgrade strictly inside this month, before now, with microseconds; times either side of it.
  async function downgraded() {
    const now = Date.now();
    const d = now - 10 * MIN > M.getTime() + 2 * MIN ? now - 10 * MIN : (M.getTime() + now) / 2;
    const dMs = new Date(Math.floor(d));
    const s = await seed({ downgradedAt: `${dMs.toISOString().slice(0, 23)}456Z` });
    const iso = (ms: number) => new Date(Math.floor(ms)).toISOString();
    return {
      s,
      period: dMs.toISOString(),
      before: iso((M.getTime() + dMs.getTime()) / 2),
      after: iso((dMs.getTime() + now) / 2),
    };
  }

  test("a downgraded account counts from downgraded_at", async () => {
    const { s, period, before, after } = await downgraded();
    await conversation(s.project, 600, before);
    await conversation(s.project, 300, after);
    await backfill();
    const [row] = await sql<{ d: string }[]>`
      select to_char(downgraded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as d
      from billing_account where id = ${s.pooled}`;
    const expected = periodStart(new Date(), "free", row?.d ?? null);
    expect(expected.toISOString()).toBe(period);
    expect(await usage(s.pooled)).toEqual({ audio_seconds: { amount: 300, period } });
  });

  test("downgrade: chats before it stay unstamped, chats spanning it claim at its millisecond", async () => {
    const { s, period, before, after } = await downgraded();
    const earlier = await chat(s.project, [before]);
    const spanning = await chat(s.project, [before, after]);
    await backfill();
    expect(await stampOf("project_chat", earlier)).toBeNull();
    expect(await stampOf("project_chat", spanning)).toBe(period);
    expect((await usage(s.pooled)).chats).toEqual({ amount: 1, period });
    expect(await freeChats(database.db).turnStatus(spanning, s.project, new Date())).toEqual({
      limit: 20,
      used: 1,
      frozen: false,
    });
  });

  test("downgrade: report and popcorn stamps equal the runtime period, so they refund", async () => {
    const { s, period, after } = await downgraded();
    const r = await report(s.project, after);
    const { loop } = await popcornLoop(s.project);
    const run1 = await popcornRun(loop, "ok", "run 1: 1 note", after);
    await backfill();
    // The refund gates (projects refundFreeReport, popcorn refund) compare the stamp to this.
    const a = await allowanceForProject(database.db, s.project, new Date());
    expect(a?.periodStart.toISOString()).toBe(period);
    expect(await stampOf("project_report", r)).toBe(period);
    expect(await stampOf("agent_loop_run", run1)).toBe(period);
    const u = await usage(s.pooled);
    expect([u.reports, u.popcorn_analyses]).toEqual([
      { amount: 1, period },
      { amount: 1, period },
    ]);
  });

  test("a client workspace whose org pool is paid counts on its own account", async () => {
    const s = await seed({ tier: "changemaker" });
    await conversation(s.clientProject, 1200, at(MIN));
    await mapRun(s.clientProject, at(MIN));
    await backfill();
    expect(await usage(s.pooled)).toEqual({});
    expect(await usage(s.own)).toEqual({
      audio_seconds: { amount: 1200, period: M.toISOString() },
      maps: { amount: 1, period: M.toISOString() },
    });
  });

  test("live metering is never lowered", async () => {
    const low = await seed();
    const high = await seed();
    for (const s of [low, high])
      await sql`insert into free_usage (billing_account_id, period_start, key, amount)
        values (${s.pooled}, ${M.toISOString()}, 'audio_seconds', 9000)`;
    await conversation(low.project, 600, at(MIN));
    await conversation(high.project, 12_000, at(MIN));
    await backfill();
    expect((await usage(low.pooled)).audio_seconds?.amount).toBe(9000);
    expect((await usage(high.pooled)).audio_seconds?.amount).toBe(12_000);
  });

  test("paid accounts are untouched", async () => {
    const s = await seed({ tier: "changemaker" });
    await conversation(s.project, 600, at(MIN));
    const c = await chat(s.project, [at(MIN)]);
    const r = await report(s.project, at(MIN));
    await mapRun(s.project, at(MIN));
    const { loop } = await popcornLoop(s.project);
    const run1 = await popcornRun(loop, "ok", "run 1: 1 note", at(MIN));
    await backfill();
    expect(await usage(s.pooled)).toEqual({});
    expect(await stampOf("project_chat", c)).toBeNull();
    expect(await stampOf("project_report", r)).toBeNull();
    expect(await stampOf("agent_loop_run", run1)).toBeNull();
  });

  test("running it twice changes nothing", async () => {
    const s = await seed();
    await conversation(s.project, 600, at(MIN));
    await chat(s.project, [at(MIN)]);
    await chat(s.project, [new Date(M.getTime() - 40 * DAY).toISOString()]);
    await report(s.project, at(MIN));
    await mapRun(s.project, at(MIN));
    const { loop } = await popcornLoop(s.project);
    await popcornRun(loop, "ok", "run 1: 1 note", at(MIN));
    const d = await downgraded();
    await chat(d.s.project, [d.before, d.after]);
    await mapRun(d.s.project, d.after);
    await backfill();
    expect(Object.keys(await usage(s.pooled)).sort()).toEqual([
      "audio_seconds",
      "chats",
      "maps",
      "popcorn_analyses",
      "reports",
    ]);
    const snapshot = async () => ({
      usage: await sql`select billing_account_id, period_start, key, amount from free_usage
        order by billing_account_id, period_start, key`,
      chats: await sql`select id, free_period_start from project_chat order by id`,
      reports: await sql`select id, free_period_start from project_report order by id`,
      runs: await sql`select id, free_period_start from agent_loop_run order by id`,
    });
    const before = await snapshot();
    await backfill();
    expect(await snapshot()).toEqual(before);
  });

  test("clears every over-cap flag", async () => {
    const s = await seed();
    const c = id();
    await sql`insert into conversation (id, project_id, is_over_cap) values (${c}, ${s.project}, true)`;
    await backfill();
    const [row] = await sql<
      { f: boolean }[]
    >`select is_over_cap as f from conversation where id = ${c}`;
    expect(row?.f).toBe(false);
  });
});
