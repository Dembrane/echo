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
import {
  type AnalysisRuntime,
  clientOf,
  type ObjectRevision,
  type Snapshot,
} from "@dembrane/analysis";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { mapRoutes } from "../src/routes";
import * as service from "../src/service";
import { MapStore } from "../src/store";

// Map generate, title, groups and fact-check refuse at budget zero; maps are no longer counted.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `map_ai_budget_${process.pid}`;
const LIMIT = 5_000_000;

run("map routes and the AI budget", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let enqueued: unknown[] = [];
  let completer: FakeCompleter;
  let api: Hono<Env>;

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
    enqueued = [];
    completer = new FakeCompleter().on(() => true, "Ferry timetables");
    // One app per test: its title cache lives as long as the API instance.
    api = app();
  });

  async function project(tier: string, isSample = false) {
    const [orgId, accountId, ws, pid] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, ${tier}, ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    await sql`insert into project (id, name, is_conversation_allowed, workspace_id, is_sample)
      values (${pid}, 'Harbour', true, ${ws}, ${isSample})`;
    return { pid, accountId };
  }

  async function spend(accountId: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${accountId}, ${monthStart(new Date()).toISOString()}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  const ledgerKeys = async (accountId: string) =>
    (
      await sql<{ key: string }[]>`select key from free_usage
        where billing_account_id = ${accountId} order by key`
    ).map((r) => r.key);

  const argumentsRuns = async (pid: string) =>
    Number(
      (
        await sql`select count(*) as n from analysis_run
          where project_id = ${pid} and recipe_id = 'arguments'`
      )[0]?.n,
    );

  // A saved v1 map with three claims: enough to title and to fact-check.
  async function savedMap(pid: string) {
    const id = randomUUID();
    const manifest = {
      arguments: [1, 2, 3].map((i) => ({
        id: `a${i}`,
        statement: `The ferry should run every ${i * 10} minutes`,
        kind: "claim",
        claim_key: `k${i}`,
      })),
    };
    await sql`insert into map_result (id, project_id, status, recipe_version, manifest,
        created_at, updated_at, completed_at)
      values (${id}, ${pid}, 'ready', 'v1', ${sql.json(manifest)}, now(), now(), now())`;
    return id;
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
      mapRoutes({
        db,
        access: allow,
        limiter,
        logger,
        jobs: {
          enqueue: async (_job: unknown, payload: unknown) => {
            enqueued.push(payload);
            return null;
          },
        } as never,
        completer,
        embedder: new FakeEmbedder(8),
        embeddingModel: "text-embedding-004",
        embeddingLocation: "europe-west4",
        nodeLimitCeiling: null,
        edgeLimitCeiling: null,
      }),
    );
    h.onError((err) =>
      Response.json(
        { error: String((err as Error).message), details: (err as { details?: unknown }).details },
        { status: (err as { status?: number }).status ?? 500 },
      ),
    );
    return h;
  }

  async function post(path: string, body: unknown = {}) {
    const res = await api.request(`/api/v2/bff/map${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown> & {
      details?: { limit?: string };
      attempt?: { id?: string; status?: string } | null;
    };
    return { status: res.status, limit: json.details?.limit, json };
  }

  const generate = (pid: string) => post(`/projects/${pid}/generate`);
  const title = (resultId: string) =>
    post(`/results/${resultId}/title`, { node_ids: ["a1", "a2", "a3"] });
  const group = (resultId: string) =>
    post(`/results/${resultId}/groups`, { snapshot_id: randomUUID(), revision_ids: ["r1"] });
  const factCheck = (resultId: string) => post(`/results/${resultId}/fact-checks/a1`);

  test("at zero, generate, an uncached title and a new fact-check refuse with no model call", async () => {
    const { pid, accountId } = await project("free");
    const resultId = await savedMap(pid);
    await spend(accountId, LIMIT);
    for (const call of [generate(pid), title(resultId), factCheck(resultId)])
      expect(await call).toMatchObject({ status: 402, limit: "ai_budget" });
    expect(await argumentsRuns(pid)).toBe(0);
    expect(enqueued).toEqual([]);
    expect(completer.calls).toHaveLength(0);
    expect(await sql`select id from map_fact_check where project_id = ${pid}`).toHaveLength(0);
  });

  test("below the limit, maps are not counted: a second and third generate start", async () => {
    const { pid, accountId } = await project("free");
    await spend(accountId, LIMIT - 1);
    for (let i = 1; i <= 3; i++) {
      const res = await generate(pid);
      expect(res).toMatchObject({ status: 202, json: { attempt: { status: "queued" } } });
      expect(await argumentsRuns(pid)).toBe(i);
      // Finished (failed here) so the next click starts a new run.
      await sql`update analysis_run set status = 'failed', completed_at = now()
        where project_id = ${pid} and recipe_id = 'arguments'`;
    }
    expect(await ledgerKeys(accountId)).toEqual([AI_SPEND_KEY]);
  });

  test("at zero, a map still generating answers a repeat click without a check", async () => {
    const { pid, accountId } = await project("free");
    const first = await generate(pid);
    expect(first.status).toBe(202);
    await spend(accountId, LIMIT);
    const again = await generate(pid);
    expect(again).toMatchObject({ status: 202, json: { attempt: { id: first.json.attempt?.id } } });
    expect(await argumentsRuns(pid)).toBe(1);
    await sql`update analysis_run set status = 'failed', completed_at = now()
      where project_id = ${pid}`;
    expect(await generate(pid)).toMatchObject({ status: 402, limit: "ai_budget" });
    expect(await argumentsRuns(pid)).toBe(1);
  });

  test("at zero, a cached title and a done or running fact-check answer without a check", async () => {
    const { pid, accountId } = await project("free");
    const resultId = await savedMap(pid);
    // Titled while there was budget; the same selection again is cached.
    expect(await title(resultId)).toMatchObject({ status: 200, json: { cached: false } });
    expect(await factCheck(resultId)).toMatchObject({ status: 200 });
    expect(enqueued).toHaveLength(1);
    await spend(accountId, LIMIT);
    const before = completer.calls.length;
    expect(await title(resultId)).toMatchObject({
      status: 200,
      json: { title: "Ferry timetables", cached: true },
    });
    // Still running: the check answers as it stands.
    expect(await factCheck(resultId)).toMatchObject({
      status: 200,
      json: { status: "processing" },
    });
    await sql`update map_fact_check set status = 'done', verdict = 'supported',
        justification = 'j', completed_at = now()
      where project_id = ${pid} and claim_key = 'k1'`;
    expect(await factCheck(resultId)).toMatchObject({ status: 200, json: { status: "done" } });
    expect(completer.calls).toHaveLength(before);
    expect(enqueued).toHaveLength(1);
    // A forced re-check, another claim, or a check gone quiet would start a job: refused.
    expect(await post(`/results/${resultId}/fact-checks/a1`, { force: true })).toMatchObject({
      status: 402,
      limit: "ai_budget",
    });
    expect(await post(`/results/${resultId}/fact-checks/a2`)).toMatchObject({
      status: 402,
      limit: "ai_budget",
    });
    await sql`update map_fact_check set status = 'processing',
        started_at = now() - interval '1 hour' where project_id = ${pid} and claim_key = 'k1'`;
    expect(await factCheck(resultId)).toMatchObject({ status: 402, limit: "ai_budget" });
    expect(enqueued).toHaveLength(1);
    const [k1] = await sql`select attempt from map_fact_check
      where project_id = ${pid} and claim_key = 'k1'`;
    expect(Number(k1?.attempt)).toBe(1);
  });

  test("at zero, an existing group answers and a new one refuses", async () => {
    const { pid, accountId } = await project("free");
    const snapshot = {
      id: randomUUID(),
      projectId: pid,
      manifest: {
        objects: [1, 2, 3, 4].map((i) => ({ revisionId: `r${i}` })),
        relations: [],
        assessments: [],
      },
    } as unknown as Snapshot;
    const revision = (i: number) =>
      ({
        id: `r${i}`,
        objectId: `o${i}`,
        projectId: pid,
        type: "argument",
        payload: { statement: `Statement ${i}` },
        attributes: {},
      }) as unknown as ObjectRevision;
    const rt = {
      store: {
        getSnapshot: async (id: string) => (id === snapshot.id ? snapshot : null),
        getRevisions: async (_p: string, ids: readonly string[]) =>
          new Map(
            ids
              .filter((id) => /^r[1-4]$/.test(id))
              .map((id) => [id, revision(Number(id.slice(1)))]),
          ),
      },
      publishMap: async () => {},
    } as unknown as AnalysisRuntime;
    const dispatched: service.GroupJob[] = [];
    const d: service.GroupDeps = {
      store: new MapStore(clientOf(db)),
      rt,
      db,
      dispatchGroup: async (job) => dispatched.push(job),
    };
    const target: service.SnapshotTarget = { kind: "snapshot", snapshot, resultId: null };
    const first = await service.requestGroup(d, target, ["r1", "r2", "r3"], "host");
    expect(dispatched).toHaveLength(1);
    await spend(accountId, LIMIT);
    // Still titling, then titled: the same selection answers with its group.
    expect((await service.requestGroup(d, target, ["r3", "r2", "r1"], "host")).id).toBe(first.id);
    await sql`update map_group set status = 'ready', title = 'T' where id = ${String(first.id)}`;
    expect(await service.requestGroup(d, target, ["r1", "r2", "r3"], "host")).toMatchObject({
      id: first.id,
      title: "T",
    });
    const refused = (ids: string[]) =>
      service.requestGroup(d, target, ids, "host").then(
        () => null,
        (e) => e,
      );
    expect(await refused(["r2", "r3", "r4"])).toMatchObject({
      status: 402,
      details: { limit: "ai_budget" },
    });
    // A failed group would run again: refused, and left as it was.
    await sql`update map_group set status = 'failed' where id = ${String(first.id)}`;
    expect(await refused(["r1", "r2", "r3"])).toMatchObject({ status: 402 });
    const [g] = await sql`select status, attempt from map_group where id = ${String(first.id)}`;
    expect(g).toMatchObject({ status: "failed", attempt: 1 });
    expect(dispatched).toHaveLength(1);
  });

  test("below the limit, title and fact-check reach the model and the queue", async () => {
    const { pid } = await project("free");
    const resultId = await savedMap(pid);
    expect(await title(resultId)).toMatchObject({ status: 200 });
    expect(completer.calls).toHaveLength(1);
    expect(await factCheck(resultId)).toMatchObject({ status: 200 });
    expect(enqueued).toHaveLength(1);
  });

  test("paid and sample projects never refuse", async () => {
    const paid = await project("changemaker");
    const sample = await project("free", true);
    for (const p of [paid, sample]) {
      await spend(p.accountId, LIMIT * 2);
      const resultId = await savedMap(p.pid);
      expect((await generate(p.pid)).status).toBe(202);
      expect((await title(resultId)).status).toBe(200);
      expect((await factCheck(resultId)).status).toBe(200);
      // Past the budget check: a v1 map has no groups.
      expect((await group(resultId)).status).toBe(409);
    }
  });
});
