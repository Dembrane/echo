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
import { Writable } from "node:stream";
import type { Access } from "@dembrane/access";
import { AI_SPEND_KEY, invalidateFreeLimits, monthStart } from "@dembrane/allowance";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { analysisRoutes } from "../src";

// The generic run route refuses at budget zero; maps and analyses are no longer counted.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `analysis_ai_budget_${process.pid}`;
const NOW = new Date();
const LIMIT = 5_000_000;

run("analysis runs and the AI budget", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let dispatched = 0;
  let completer: FakeCompleter;

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

  beforeEach(() => {
    invalidateFreeLimits();
    dispatched = 0;
    completer = new FakeCompleter();
  });

  async function project(tier: string, isSample = false) {
    const [orgId, accountId, ws, pid] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, ${tier}, ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample)
      values (${pid}, true, ${ws}, ${isSample})`;
    return { pid, accountId };
  }

  async function spend(accountId: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${accountId}, ${monthStart(NOW).toISOString()}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  const ledgerKeys = async (accountId: string) =>
    (
      await sql<{ key: string }[]>`select key from free_usage
        where billing_account_id = ${accountId} order by key`
    ).map((r) => r.key);

  const runs = async (pid: string) =>
    Number((await sql`select count(*) as n from analysis_run where project_id = ${pid}`)[0]?.n);

  function app() {
    const allow = {
      project: async () => ({ project: { id: "p", isSample: false }, tier: "free" }),
    } as unknown as Access;
    const limiter = { check: async () => {} } as unknown as RateLimiter;
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "error" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
    const h = new Hono<Env>();
    h.use(async (c, next) => {
      c.set("principal", { appUserId: randomUUID(), directusUserId: randomUUID() } as never);
      await next();
    });
    h.route(
      "/",
      analysisRoutes({
        db,
        access: allow,
        limiter,
        logger,
        jobs: {
          enqueue: async () => {
            dispatched++;
            return null;
          },
        },
        completer,
        embedder: new FakeEmbedder(8),
        enablePresent: false,
        embeddingModel: "text-embedding-004",
        embeddingLocation: "europe-west4",
        now: () => NOW,
      }),
    );
    h.onError((err) =>
      Response.json(
        { details: (err as { details?: unknown }).details },
        { status: (err as { status?: number }).status ?? 500 },
      ),
    );
    return h;
  }

  async function post(pid: string, body: Record<string, unknown>) {
    const res = await app().request(`/api/v2/bff/analysis/projects/${pid}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      outcome?: string;
      run?: { id: string };
      details?: { limit?: string };
    };
    return {
      status: res.status,
      outcome: json.outcome,
      runId: json.run?.id,
      limit: json.details?.limit,
    };
  }

  test("at zero, every run request refuses before anything starts", async () => {
    const { pid, accountId } = await project("free");
    await spend(accountId, LIMIT);
    for (const body of [
      { recipe_id: "arguments", mode: "regenerate" },
      { recipe_id: "deduplicated_arguments" },
      { recipe_id: "stakeholders" },
      { recipe_id: "tensions", parameters: { input_set: "arguments" }, refresh_dependencies: true },
    ])
      expect(await post(pid, body)).toMatchObject({ status: 402, limit: "ai_budget" });
    expect(await runs(pid)).toBe(0);
    expect(dispatched).toBe(0);
    expect(completer.calls).toHaveLength(0);
  });

  test("at zero, a retry of a failed run refuses", async () => {
    const { pid, accountId } = await project("free");
    const first = await post(pid, { recipe_id: "stakeholders" });
    expect(first.status).toBe(202);
    await sql`update analysis_run set status = 'failed', completed_at = now()
      where id = ${first.runId as string}`;
    await spend(accountId, LIMIT);
    const before = dispatched;
    expect(
      await post(pid, { recipe_id: "stakeholders", mode: "retry", retry_run_id: first.runId }),
    ).toMatchObject({ status: 402, limit: "ai_budget" });
    const [r] = await sql`select status from analysis_run where id = ${first.runId as string}`;
    expect(r?.status).toBe("failed");
    expect(dispatched).toBe(before);
  });

  test("below the limit, runs are not counted or stamped", async () => {
    const { pid, accountId } = await project("free");
    await spend(accountId, LIMIT - 1);
    for (let i = 0; i < 3; i++)
      expect(await post(pid, { recipe_id: "arguments", mode: "regenerate" })).toMatchObject({
        status: 202,
        outcome: "created",
      });
    for (let i = 0; i < 3; i++)
      expect(await post(pid, { recipe_id: "stakeholders", mode: "regenerate" })).toMatchObject({
        status: 202,
        outcome: "created",
      });
    const stamped =
      await sql`select id from analysis_run where project_id = ${pid} and free_period_start is not null`;
    expect(stamped).toHaveLength(0);
    expect(await ledgerKeys(accountId)).toEqual([AI_SPEND_KEY]);
  });

  test("below the limit, a failed run is retried once", async () => {
    const { pid } = await project("free");
    const first = await post(pid, { recipe_id: "stakeholders" });
    const runId = first.runId as string;
    await sql`update analysis_run set status = 'failed', completed_at = now() where id = ${runId}`;
    const body = { recipe_id: "stakeholders", mode: "retry", retry_run_id: runId };
    const outcomes = (await Promise.all([post(pid, body), post(pid, body)])).map((r) => r.outcome);
    expect(outcomes.sort()).toEqual(["existing", "requeued"]);
    const [r] = await sql`select status from analysis_run where id = ${runId}`;
    expect(r?.status).toBe("queued");
  });

  test("paid and sample projects never refuse", async () => {
    for (const p of [await project("changemaker"), await project("free", true)]) {
      await spend(p.accountId, LIMIT * 2);
      for (const recipe of ["arguments", "stakeholders"])
        expect((await post(p.pid, { recipe_id: recipe, mode: "regenerate" })).status).toBe(202);
    }
  });
});
