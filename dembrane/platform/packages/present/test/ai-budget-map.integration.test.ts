import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { AI_SPEND_KEY, invalidateFreeLimits, monthStart } from "@dembrane/allowance";
import { analysisRuntime, clientOf } from "@dembrane/analysis";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { MapStore as MapRows } from "@dembrane/map";
import { createLogger } from "@dembrane/observability";
import { analysisMapStore } from "../src/map";

// The room's map request at budget zero keeps the map it has and starts nothing.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `present_ai_budget_${process.pid}`;

run("the present room's map at budget zero", () => {
  setDefaultTimeout(60_000);
  let sql: ReturnType<typeof connect>;
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
    const made = createDb({ url, poolMax: 4 });
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

  test("the request resolves quietly and starts no run", async () => {
    invalidateFreeLimits();
    const [orgId, accountId, ws, pid] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'free', ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    await sql`insert into project (id, is_conversation_allowed, workspace_id)
      values (${pid}, true, ${ws})`;
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${accountId}, ${monthStart(new Date()).toISOString()}, ${AI_SPEND_KEY}, 5000000)`;
    let enqueued = 0;
    const rt = analysisRuntime({
      db,
      logger: createLogger(
        { service: "t", release: "r", env: "test", level: "error" },
        new Writable({ write: (_c, _e, cb) => cb() }),
      ),
      // No model is reached at zero.
      completer: {} as never,
      embedder: {} as never,
      jobs: {
        enqueue: async () => {
          enqueued++;
          return null;
        },
      },
      config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
    });
    const store = analysisMapStore(
      rt,
      new MapRows(clientOf(db)),
      {
        nodeLimit: null,
        edgeLimit: null,
      },
      db,
    );
    expect(await store.requestGeneration(pid, null)).toBe(false);
    expect(await sql`select id from analysis_run where project_id = ${pid}`).toHaveLength(0);
    expect(enqueued).toBe(0);
  });
});
