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
import { invalidateFreeLimits } from "@dembrane/allowance";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { startFreeMap } from "../src/free";
import { type MapDeps, requestGeneration } from "../src/service";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `map_free_${process.pid}`;
const NOW = new Date("2026-10-15T12:00:00Z");

run("free map generations", () => {
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

  async function workspace(tier: string) {
    const orgId = randomUUID();
    const accountId = randomUUID();
    const ws = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'o')`;
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, ${tier}, ${orgId})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    return { ws, accountId };
  }

  async function project(ws: string | null, sample = false) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample)
      values (${id}, true, ${ws}, ${sample})`;
    return id;
  }

  async function used(accountId: string): Promise<number | null> {
    const rows = await sql<{ amount: string }[]>`select amount from free_usage
      where billing_account_id = ${accountId} and key = 'maps'`;
    return rows[0] ? Number(rows[0].amount) : null;
  }

  const ok = async () => ({ row: "run", started: true });
  const caught = (p: Promise<unknown>) =>
    Promise.resolve(p).then(
      () => null,
      (e) => e,
    );

  test("one generation per period", async () => {
    const { ws, accountId } = await workspace("free");
    const p = await project(ws);
    expect(await startFreeMap(db, p, NOW, ok)).toBe("run");
    const err = await caught(startFreeMap(db, p, NOW, ok));
    expect(err).toMatchObject({ status: 402, details: { limit: "map", used: 1, cap: 1 } });
    expect(await used(accountId)).toBe(1);
  });

  test("a start that throws or reuses gives the map back", async () => {
    const { ws, accountId } = await workspace("free");
    const p = await project(ws);
    const boom = new Error("boom");
    const err = await caught(
      startFreeMap(db, p, NOW, async () => {
        throw boom;
      }),
    );
    expect(err).toBe(boom);
    expect(await used(accountId)).toBe(0);
    expect(await startFreeMap(db, p, NOW, async () => ({ row: "old", started: false }))).toBe(
      "old",
    );
    expect(await used(accountId)).toBe(0);
    expect(await startFreeMap(db, p, NOW, ok)).toBe("run");
    expect(await used(accountId)).toBe(1);
  });

  test("two generations race for the last map", async () => {
    const { ws, accountId } = await workspace("free");
    const p1 = await project(ws);
    const p2 = await project(ws);
    const results = await Promise.allSettled(
      [p1, p2, p1, p2, p1].map((p) => startFreeMap(db, p, NOW, ok)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await used(accountId)).toBe(1);
  });

  test("unlimited accounts start without a ledger row", async () => {
    const changemaker = await workspace("changemaker");
    const pioneer = await workspace("pioneer");
    const free = await workspace("free");
    const projects = [
      await project(changemaker.ws),
      await project(pioneer.ws),
      await project(null),
      await project(free.ws, true),
    ];
    for (const p of projects)
      for (let i = 0; i < 3; i++) expect(await startFreeMap(db, p, NOW, ok)).toBe("run");
    for (const a of [changemaker, pioneer, free]) expect(await used(a.accountId)).toBeNull();
  });
  test("a start that fails keeps its own error when the give-back fails too", async () => {
    const { ws } = await workspace("free");
    const p = await project(ws);
    let armed = false;
    const flaky = new Proxy(db, {
      get(t, k) {
        if (k === "transaction" && armed) return () => Promise.reject(new Error("give-back down"));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const logged: unknown[] = [];
    const logger = { error: (o: unknown) => logged.push(o) } as unknown as Logger;
    const boom = new Error("boom");
    const err = await caught(
      startFreeMap(
        flaky,
        p,
        NOW,
        async () => {
          armed = true;
          throw boom;
        },
        { logger },
      ),
    );
    expect(err).toBe(boom);
    expect(logged).toHaveLength(1);
  });

  test("a map still generating answers a second click without counting", async () => {
    const { ws, accountId } = await workspace("free");
    const p = await project(ws);
    expect(await startFreeMap(db, p, NOW, ok)).toBe("run");
    const run = {
      id: "run-1",
      status: "running",
      createdAt: "2026-10-15T11:59:00Z",
      updatedAt: "2026-10-15T11:59:30Z",
      completedAt: null,
      error: null,
      progress: { stage: "embedding" },
    };
    const d = {
      db,
      now: () => NOW,
      store: { expireStale: async () => 0, activeAttempt: async () => null },
      rt: {
        store: {
          findScope: async () => ({ id: "scope-1" }),
          latestRun: async () => run,
        },
      },
    } as unknown as MapDeps;
    const attempt = await requestGeneration(d, p, "u");
    expect(attempt).toMatchObject({ id: "run-1", status: "embedding" });
    expect(await used(accountId)).toBe(1);
  });

  test("paid and sample projects with a run in flight still ask the executor", async () => {
    const changemaker = await workspace("changemaker");
    const free = await workspace("free");
    const reached = new Error("requestRun reached");
    let peeked = 0;
    const d = {
      db,
      now: () => NOW,
      store: { expireStale: async () => 0, activeAttempt: async () => null },
      rt: {
        store: {
          findScope: async () => {
            peeked++;
            return { id: "scope-1" };
          },
          latestRun: async () => ({ id: "run-1", status: "running", progress: {} }),
        },
        // Any executor read proves the old refresh path ran, which queues on changed inputs.
        executor: {
          store: new Proxy(
            {},
            {
              get: () => () => {
                throw reached;
              },
            },
          ),
        },
      },
    } as unknown as MapDeps;
    for (const p of [await project(changemaker.ws), await project(free.ws, true)])
      expect(await caught(requestGeneration(d, p, "u"))).toBe(reached);
    expect(peeked).toBe(0);
    expect(await used(changemaker.accountId)).toBeNull();
  });
});
