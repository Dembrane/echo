import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { liveServices } from "@dembrane/conversations";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import type { DataDeps } from "../src/data/deps";
import { monitor } from "../src/data/monitor";

/**
 * The assistant's live-status tool against a copy of the parity seed, with presence written
 * the way participant and visitor pings write it: liveness from pings and the funnel.
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
const alice: Signed = { appUserId: id("a0", 2), directusUserId: id("d0", 2), isStaff: false };
const p1 = id("f0", 1);
const c2 = id("c1", 2);
const DB = "agentic_monitor_test";
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const ago = (now: Date, s: number) => new Date(now.getTime() - s * 1000);

type Payload = Awaited<ReturnType<typeof monitor>>;
const row = (p: Payload, cid: string) => p.conversations.find((c) => c.id === cid);

run("assistant live status", () => {
  setDefaultTimeout(30_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: DataDeps;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    await migrate(`${base}/${DB}`, { appEnv: "test" });
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      logger: quiet,
      now: () => new Date(),
    };
    // c2 is the seed's unfinished conversation; without its one old chunk it has never sent audio.
    await sql`delete from conversation_chunk where conversation_id = ${c2}`;
  });
  beforeEach(async () => {
    await sql`delete from platform_presence`;
  });
  afterAll(async () => {
    await Promise.allSettled([sql.end(), database.close()]);
  });

  const presence = () => liveServices(d).presence;

  test("a recent ping is live before any chunk arrives", async () => {
    const now = new Date();
    await presence().recordPing({
      conversationId: c2,
      now: ago(now, 3),
      liveness: { telemetry: { state: "recording", mode: "audio", battery: 0.8 } },
      activeProjectId: p1,
    });
    await presence().markConversationSeen(
      c2,
      { state: "recording", mode: "audio", battery: 0.8 },
      ago(now, 3),
    );

    const out = await monitor(d, alice, p1, 45);
    const c = row(out, c2);
    expect(c).toMatchObject({
      is_live: true,
      state: "recording",
      recording_health: "waiting",
      mode: "audio",
      battery: 0.8,
      chunk_count: 0,
      last_chunk_at: null,
    });
    expect(c?.last_seen_at).toBeString();
    expect(((c?.timeline ?? []) as { key: string }[]).map((t) => t.key)).toEqual([
      "created",
      "recording_started",
    ]);
    expect(out.summary.live).toBe(1);
    expect(out.conversations[0]?.id).toBe(c2);
  });

  test("a ping past the heartbeat grace is offline, not live", async () => {
    const now = new Date();
    await presence().recordPing({
      conversationId: c2,
      now: ago(now, 30),
      liveness: { telemetry: { state: "recording" } },
      activeProjectId: p1,
    });

    const out = await monitor(d, alice, p1, 45);
    expect(row(out, c2)).toMatchObject({
      is_live: false,
      state: "offline",
      recording_health: "offline",
    });
    expect(out.summary).toMatchObject({ live: 0, offline: 1 });
  });

  test("the funnel counts visitors at each stage and drops the ones who started", async () => {
    const now = new Date();
    const visit = (vid: string, stage: string, s: number, extra: Record<string, unknown> = {}) =>
      presence().markVisitorSeen(p1, vid, { stage, ...extra }, ago(now, s));
    await visit("v-scan", "scanned", 20, { device: "ios" });
    await visit("v-terms", "scanned", 18);
    await visit("v-terms", "terms", 12);
    await visit("v-old-mic", "mic_ok", 10);
    await visit("v-profile", "scanned", 9);
    await visit("v-profile", "profile", 4, { name: "  Ada  ", tags: ["energy"] });
    await visit("v-started", "profile", 2);
    await presence().linkVisitorConversation("v-started", c2, ago(now, 1));

    const { funnel } = await monitor(d, alice, p1, 45);
    expect(funnel.summary as Record<string, number>).toEqual({
      scanned: 1,
      terms: 2,
      profile: 1,
      total: 4,
    });
    expect(funnel.visitors.map((v) => [v.id, v.stage])).toEqual([
      ["v-profile", "profile"],
      ["v-old-mic", "terms"],
      ["v-terms", "terms"],
      ["v-scan", "scanned"],
    ]);
    const ada = funnel.visitors[0] as Record<string, unknown>;
    expect(ada).toMatchObject({ name: "Ada", tags: ["energy"], scan_count: 1 });
    expect(Object.keys(ada.stages as object).sort()).toEqual(["profile", "scanned"]);
    expect(funnel.visitors[3]).toMatchObject({ device: "ios" });
  });
});
