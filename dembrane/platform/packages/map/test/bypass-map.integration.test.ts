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
import { invalidateFreeLimits } from "@dembrane/allowance";
import { analysisRoutes } from "@dembrane/analysis";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { startFreeMap } from "../src/free";

// Adversarial replays: each test passes only once the bypass is closed.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `map_bypass_${process.pid}`;
const NOW = new Date();

run("free map bypasses", () => {
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
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  beforeEach(() => invalidateFreeLimits());

  async function freeProject() {
    const [orgId, accountId, ws, pid] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'free', ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    await sql`insert into project (id, is_conversation_allowed, workspace_id)
      values (${pid}, true, ${ws})`;
    return { pid, accountId };
  }

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
        jobs: { enqueue: async () => null },
        completer: new FakeCompleter(),
        embedder: new FakeEmbedder(8),
        enablePresent: false,
        embeddingModel: "text-embedding-004",
        embeddingLocation: "europe-west4",
        now: () => NOW,
      }),
    );
    h.onError((err) =>
      Response.json(
        { error: String((err as Error).message) },
        { status: (err as { status?: number }).status ?? 500 },
      ),
    );
    return h;
  }

  const argumentsRuns = async (pid: string) =>
    Number(
      (
        await sql`select count(*) as n from analysis_run
          where project_id = ${pid} and recipe_id = 'arguments'`
      )[0]?.n,
    );

  // The month's map is spent through the map route; the generic analysis route still starts
  // an arguments run (the map recipe, scope "project"), so the map regenerates uncounted.
  test("the generic analysis route cannot start a map once the month's map is spent", async () => {
    const { pid, accountId } = await freeProject();
    expect(await startFreeMap(db, pid, NOW, async () => ({ row: "run", started: true }))).toBe(
      "run",
    );
    const [ledger] = await sql`select amount from free_usage
      where billing_account_id = ${accountId} and key = 'maps'`;
    expect(Number(ledger?.amount)).toBe(1);

    const res = await app().request(`/api/v2/bff/analysis/projects/${pid}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipe_id: "arguments", mode: "regenerate" }),
    });
    const body = await res.text();
    expect({ status: res.status, body }).toMatchObject({ status: 402 });
    expect(await argumentsRuns(pid)).toBe(0);
  });

  // Tensions (and deduplication) pull a fresh arguments run in as a dependency.
  test("a tensions run cannot refresh the map as its dependency once the map is spent", async () => {
    const { pid } = await freeProject();
    await startFreeMap(db, pid, NOW, async () => ({ row: "run", started: true }));
    const res = await app().request(`/api/v2/bff/analysis/projects/${pid}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipe_id: "tensions",
        parameters: { input_set: "arguments" },
        refresh_dependencies: true,
      }),
    });
    const body = await res.text();
    expect({ status: res.status, body }).toMatchObject({ status: 402 });
    expect(await argumentsRuns(pid)).toBe(0);
  });
});
