import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { createDb, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import { PostgresRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { liveRoutes, liveServices } from "../src/live/routes";
import { ParticipantTokens } from "../src/participant-token";

/**
 * The database cost of one steady-state participant ping (a recording conversation the
 * meter already knows, the monitor on), counted on the parity seed: round trips as the
 * driver sends them, transactions and row writes as Postgres counts them. A ping every
 * 3 s per phone is the platform's hottest write, so this pins it at one statement.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = process.env.PARITY_TEMPLATE ?? "parity_template_platform";
const base = admin ? admin.slice(0, admin.lastIndexOf("/")) : "";
const hasTemplate = admin
  ? await (async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
      await sql.end();
      return Boolean(row);
    })().catch(() => false)
  : false;
const run = hasTemplate ? describe : describe.skip;

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const p1 = id("f0", 1);
const c1 = id("c1", 1);
const DB = `conv_ping_writes_${process.pid}`;
const N = 200;
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

type Stats = { xacts: number; ins: number; upd: number; del: number };

async function dbStats(): Promise<Stats> {
  const sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
  const [r] = await sql<{ xacts: number; ins: number; upd: number; del: number }[]>`
    select xact_commit::int as xacts, tup_inserted::int as ins, tup_updated::int as upd,
           tup_deleted::int as del
    from pg_stat_database where datname = ${DB}`;
  await sql.end();
  return r as Stats;
}

run("database cost of a participant ping", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;

  const build = () => {
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    const d: ConversationsDeps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: {} as ConversationsDeps["audio"],
      audioUrls: {} as ConversationsDeps["audioUrls"],
      jobs: { enqueue: async () => null },
      models: {} as ConversationsDeps["models"],
      media: {} as ConversationsDeps["media"],
      transcriber: {} as ConversationsDeps["transcriber"],
      hub: null,
      // The production limiter: its counter lives in Postgres.
      limiter: new RateLimiter(new PostgresRateCounter(database.db)),
      logger: quiet,
      tokens: new ParticipantTokens("s".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: true,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => new Date(),
    };
    const app = new Hono<Env>();
    app.route("/", liveRoutes(d));
    return { d, app };
  };
  let ts = 1;
  const ping = (app: Hono<Env>) =>
    app.request(`/api/participant/conversations/${c1}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify({ project_id: p1, state: "recording", mode: "voice", client_ts: ts++ }),
    });

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    await migrate(`${base}/${DB}`, { appEnv: "test" });
  });
  afterAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  test("a steady-state ping is one round trip and one transaction", async () => {
    // Warm up: initiate registers the conversation with the meter, the first pings fill
    // the per-process billing context cache and stamp the recording start.
    {
      const { d, app } = build();
      await liveServices(d).meter.meter(p1, c1, "open", new Date());
      for (let i = 0; i < 3; i++) expect(await (await ping(app)).json()).toEqual({ ok: true });
      await database.close();
    }
    // Backends report their counters to pg_stat_database when idle for a second or on exit.
    await Bun.sleep(1200);
    const before = await dbStats();

    const { d, app } = build();
    await liveServices(d).meter.meter(p1, c1, "open", new Date());
    await ping(app);
    const queries: string[] = [];
    (database.client.options as { debug: unknown }).debug = (_c: number, q: string) =>
      queries.push(q.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
    for (let i = 0; i < N; i++) expect(await (await ping(app)).json()).toEqual({ ok: true });
    (database.client.options as { debug: unknown }).debug = false;
    await database.close();
    await Bun.sleep(1200);
    const after = await dbStats();

    const perPing = (n: number) => Math.round((n / N) * 100) / 100;
    const kinds: Record<string, number> = {};
    for (const q of queries) kinds[q] = (kinds[q] ?? 0) + 1;
    const report = {
      round_trips: perPing(queries.length),
      statements: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, perPing(v)])),
      transactions: perPing(after.xacts - before.xacts),
      rows_inserted: perPing(after.ins - before.ins),
      rows_updated: perPing(after.upd - before.upd),
      rows_deleted: perPing(after.del - before.del),
    };
    process.stdout.write(`per ping over ${N} pings: ${JSON.stringify(report)}\n`);
    // One statement per ping, plus the presence prune every 200 writes.
    expect(queries.filter((q) => q !== "delete").length).toBe(N);
    // One transaction per ping; the rest is the pool connecting and this test's own reads.
    expect(report.transactions).toBeLessThan(1.2);
    // The liveness row, the active index entry and the meter's session row.
    expect(report.rows_inserted + report.rows_updated).toBeLessThan(3.3);
  });
});
