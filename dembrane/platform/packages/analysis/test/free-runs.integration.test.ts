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
import { invalidateFreeLimits, setFreeLimit } from "@dembrane/allowance";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { analysisRoutes } from "../src";

// The generic run route charges free maps and popcorn analyses for runs it starts.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `analysis_free_runs_${process.pid}`;
const NOW = new Date();

run("free runs on the generic analysis route", () => {
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

  const used = async (accountId: string, key: string) =>
    Number(
      (
        await sql`select coalesce(sum(amount), 0) as n from free_usage
          where billing_account_id = ${accountId} and key = ${key}`
      )[0]?.n,
    );

  let dispatched = 0;
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

  test("a started map run takes the month's map; the next one is refused", async () => {
    const { pid, accountId } = await project("free");
    expect(await post(pid, { recipe_id: "arguments", mode: "regenerate" })).toMatchObject({
      status: 202,
      outcome: "created",
    });
    expect(await used(accountId, "maps")).toBe(1);
    expect(await post(pid, { recipe_id: "arguments", mode: "regenerate" })).toMatchObject({
      status: 402,
      limit: "map",
    });
    expect(await used(accountId, "maps")).toBe(1);
  });

  test("stakeholders takes one popcorn analysis; joining work in flight gives it back", async () => {
    const { pid, accountId } = await project("free");
    expect(await post(pid, { recipe_id: "stakeholders" })).toMatchObject({
      status: 202,
      outcome: "created",
    });
    expect(await post(pid, { recipe_id: "stakeholders" })).toMatchObject({
      status: 202,
      outcome: "existing",
    });
    expect(await used(accountId, "popcorn_analyses")).toBe(1);
    expect(await used(accountId, "maps")).toBe(0);
  });

  test("retrying a failed map run takes a map; a retry that requeues nothing gives it back", async () => {
    const { pid, accountId } = await project("free");
    await setFreeLimit(db, "maps_month", 3, null);
    invalidateFreeLimits();
    try {
      const first = await post(pid, { recipe_id: "arguments", mode: "regenerate" });
      expect(first.status).toBe(202);
      await sql`update analysis_run set status = 'failed', completed_at = now() where id = ${first.runId as string}`;
      expect(await post(pid, { recipe_id: "arguments", mode: "retry" })).toMatchObject({
        status: 202,
        outcome: "requeued",
      });
      expect(await used(accountId, "maps")).toBe(2);
      expect(
        await post(pid, { recipe_id: "arguments", mode: "retry", retry_run_id: first.runId }),
      ).toMatchObject({ status: 202, outcome: "existing" });
      expect(await used(accountId, "maps")).toBe(2);
    } finally {
      await setFreeLimit(db, "maps_month", 1, null);
      invalidateFreeLimits();
    }
  });

  test("paid and sample projects are not counted", async () => {
    for (const p of [await project("changemaker"), await project("free", true)]) {
      for (const recipe of ["arguments", "stakeholders"])
        expect((await post(p.pid, { recipe_id: recipe, mode: "regenerate" })).status).toBe(202);
      expect(await used(p.accountId, "maps")).toBe(0);
      expect(await used(p.accountId, "popcorn_analyses")).toBe(0);
    }
  });
  // Deduplication plans arguments first: one map covers both.
  test("deduplication on an empty free month takes one map", async () => {
    const { pid, accountId } = await project("free");
    expect(await post(pid, { recipe_id: "deduplicated_arguments" })).toMatchObject({
      status: 202,
      outcome: "created",
    });
    expect(await runs(pid)).toBe(2);
    expect(await used(accountId, "maps")).toBe(1);
  });

  test("deduplication with the map spent is refused with nothing started", async () => {
    const { pid, accountId } = await project("free");
    await post(pid, { recipe_id: "arguments", mode: "regenerate" });
    const before = { runs: await runs(pid), dispatched };
    expect(
      await post(pid, { recipe_id: "deduplicated_arguments", mode: "regenerate" }),
    ).toMatchObject({
      status: 402,
      limit: "map",
    });
    expect({ runs: await runs(pid), dispatched }).toEqual(before);
    expect(await used(accountId, "maps")).toBe(1);
  });

  // Tensions on deduplication: one map for arguments plus deduplication, one popcorn analysis.
  test("tensions on deduplication takes one map and one popcorn analysis", async () => {
    const { pid, accountId } = await project("free");
    const body = { recipe_id: "tensions", parameters: { input_set: "deduplicated_arguments" } };
    expect(await post(pid, body)).toMatchObject({ status: 202, outcome: "created" });
    expect(await runs(pid)).toBe(3);
    expect(await used(accountId, "maps")).toBe(1);
    expect(await used(accountId, "popcorn_analyses")).toBe(1);
    // With the map spent and nothing ready, a fresh chain is refused before anything starts.
    const before = { runs: await runs(pid), dispatched };
    expect(await post(pid, { ...body, refresh_dependencies: true })).toMatchObject({
      status: 402,
      limit: "map",
    });
    expect({ runs: await runs(pid), dispatched }).toEqual(before);
    expect(await used(accountId, "popcorn_analyses")).toBe(1);
  });
});
