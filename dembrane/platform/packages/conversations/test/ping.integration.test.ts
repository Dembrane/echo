import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { createDb, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hub } from "@dembrane/realtime";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { type BillingContext, RecordingMeter } from "../src/live/meter";
import {
  LIVENESS_TTL_SECONDS,
  NEGATIVE_MARKER,
  Presence,
  STICKY_STATE_TTL_SECONDS,
} from "../src/live/presence";
import { liveRecordings, liveRoutes, monitorChannel } from "../src/live/routes";
import { ParticipantTokens } from "../src/participant-token";

/**
 * The participant ping's single statement against the parity seed: the liveness rules
 * (first recording stamp, out-of-order drops, expiry, sticky states), the active index,
 * the monitor nudge, the recording meter (present, refresh, close, unregistered and
 * foreign conversations, the overage count) and the route's gates (token, text mode,
 * monitor off, the per-process rate limit).
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
const text = id("c1", 2);
const foreign = id("c1", 3);
const DB = `conv_ping_test_${process.pid}`;
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const T0 = new Date("2026-09-29T10:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

run("participant ping", () => {
  setDefaultTimeout(30_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let listener: postgres.Sql;
  let hub: Hub;
  let presence: Presence;
  let account: string;
  let n = 100;
  /** A fresh portal audio conversation in p1, copied from the seed's c1. */
  const conversation = async () => {
    const cid = id("c9", n++);
    await sql`
      insert into conversation
      select (jsonb_populate_record(null::conversation, to_jsonb(c) || jsonb_build_object(
        'id', ${cid}::text, 'recording_started_at', null, 'is_finished', false))).*
      from conversation c where c.id = ${c1}`;
    return cid;
  };
  const liveness = async (cid: string) =>
    (
      await sql<{ data: Record<string, unknown>; expires_at: Date }[]>`
        select data, expires_at from platform_presence where kind = 'liveness' and key = ${cid}`
    )[0];
  const sessions = async (cid: string) => [
    ...(await sql<{ scope: string; seen_at: Date }[]>`
      select scope, seen_at from platform_presence where kind = 'rec_session' and key = ${cid}`),
  ];

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    await migrate(`${base}/${DB}`, { appEnv: "test" });
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    listener = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    hub = new Hub(listener, quiet);
    await hub.start();
    presence = new Presence(database.db);
    const [ws] = await sql`
      select w.billing_account_id from project p join workspace w on w.id = p.workspace_id
      where p.id = ${p1}`;
    account = String(ws?.billing_account_id);
  });
  afterAll(async () => {
    await hub.stop();
    await Promise.allSettled([sql.end(), listener.end(), database.close()]);
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  describe("liveness", () => {
    const seen = (cid: string, telemetry: Record<string, unknown> | null, now: Date) =>
      presence.markConversationSeen(cid, telemetry, now);

    test("the first recording ping stamps the start once; later states carry it", async () => {
      const cid = await conversation();
      expect(await seen(cid, { state: "paused", client_ts: 1 }, at(0))).toBeNull();
      expect(await seen(cid, { state: "recording", client_ts: 2 }, at(1))).toBe(
        "2026-09-29T10:00:01+00:00",
      );
      expect(await seen(cid, { state: "recording", client_ts: 3 }, at(2))).toBeNull();
      expect(await seen(cid, { state: "paused", client_ts: 4 }, at(3))).toBeNull();
      const row = await liveness(cid);
      expect(row?.data).toEqual({
        seen: "2026-09-29T10:00:03+00:00",
        state: "paused",
        client_ts: 4,
        recording_started_at: "2026-09-29T10:00:01+00:00",
      });
    });

    test("an older client_ts is dropped; a ping without one, or onto a row without one, is kept", async () => {
      const cid = await conversation();
      await seen(cid, { state: "recording" }, at(0));
      // The stored row has no client_ts: any ping lands.
      await seen(cid, { state: "paused", client_ts: 50 }, at(1));
      expect((await liveness(cid))?.data.state).toBe("paused");
      await seen(cid, { state: "left", client_ts: 49 }, at(2));
      expect((await liveness(cid))?.data).toMatchObject({ state: "paused", client_ts: 50 });
      // Equal is not older.
      await seen(cid, { state: "verifying", client_ts: 50 }, at(3));
      expect((await liveness(cid))?.data.state).toBe("verifying");
      // Without a client_ts the ping cannot be judged older, and it replaces the telemetry.
      await seen(cid, { state: "recording" }, at(4));
      expect((await liveness(cid))?.data).toEqual({
        seen: "2026-09-29T10:00:04+00:00",
        state: "recording",
        recording_started_at: "2026-09-29T10:00:00+00:00",
      });
      // Client stamps in milliseconds are past a 32-bit integer.
      await seen(cid, { state: "paused", client_ts: 1_790_000_000_000 }, at(5));
      await seen(cid, { state: "recording", client_ts: 1_789_999_999_999 }, at(6));
      expect((await liveness(cid))?.data.state).toBe("paused");
    });

    test("an expired row counts as absent: no drop, no carried stamp", async () => {
      const cid = await conversation();
      await seen(cid, { state: "recording", client_ts: 100 }, at(0));
      const later = at(LIVENESS_TTL_SECONDS + 1);
      // Past the TTL the old row is gone as far as a ping can tell, so a recording ping is
      // the first again and an older client_ts is not compared.
      expect(await seen(cid, { state: "recording", client_ts: 5 }, later)).toBe(
        "2026-09-29T10:01:31+00:00",
      );
      expect((await liveness(cid))?.data).toMatchObject({
        client_ts: 5,
        recording_started_at: "2026-09-29T10:01:31+00:00",
      });
    });

    test("capture states live 90 seconds, sticky states 30 minutes; unknown fields are dropped", async () => {
      const cid = await conversation();
      await seen(cid, { state: "recording", junk: 1, audio_level: 0.5 }, at(0));
      let row = await liveness(cid);
      expect(row?.expires_at.getTime()).toBe(at(LIVENESS_TTL_SECONDS).getTime());
      expect(row?.data).not.toHaveProperty("junk");
      expect(row?.data.audio_level).toBe(0.5);
      await seen(cid, { state: "backgrounded" }, at(1));
      row = await liveness(cid);
      expect(row?.expires_at.getTime()).toBe(at(1 + STICKY_STATE_TTL_SECONDS).getTime());
      const read = await presence.telemetryMany([cid], at(20 * 60));
      expect(read.get(cid)?.state).toBe("backgrounded");
      expect(read.get(cid)?.seen.toISOString()).toBe(at(1).toISOString());
    });
  });

  describe("active index and nudge", () => {
    test("a ping indexes the conversation under its project and nudges once, even when dropped as older", async () => {
      const cid = await conversation();
      const nudges: unknown[] = [];
      const off = hub.subscribe([monitorChannel(p1)], (e) => nudges.push(e));
      try {
        await presence.recordPing({
          conversationId: cid,
          now: at(0),
          liveness: { telemetry: { state: "recording", client_ts: 9 } },
          activeProjectId: p1,
          notify: {
            pgChannel: "echo_live",
            payload: JSON.stringify({ c: monitorChannel(p1), e: { type: "dirty" } }),
          },
        });
        const r = await presence.recordPing({
          conversationId: cid,
          now: at(3),
          liveness: { telemetry: { state: "paused", client_ts: 1 } },
          activeProjectId: p1,
          notify: {
            pgChannel: "echo_live",
            payload: JSON.stringify({ c: monitorChannel(p1), e: { type: "dirty" } }),
          },
        });
        expect(r.first).toBeNull();
        expect((await liveness(cid))?.data.state).toBe("recording");
        expect(await presence.activeConversationIds(p1, at(2), at(3))).toContain(cid);
        // An active entry outlives the liveness row, as the Redis index did.
        expect(await presence.activeConversationIds(p1, at(0), at(30 * 60))).toContain(cid);
        for (let i = 0; i < 50 && nudges.length < 2; i++) await Bun.sleep(20);
        expect(nudges).toEqual([{ type: "dirty" }, { type: "dirty" }]);
      } finally {
        off();
      }
    });
  });

  describe("recording meter", () => {
    const meterWith = (observed: number[] = []) =>
      new RecordingMeter(
        database.db,
        presence,
        quiet,
        async (_ctx: BillingContext, count: number) => {
          observed.push(count);
        },
      );
    /** The route's metering: plan, one statement, settle. */
    const meterPing = async (
      meter: RecordingMeter,
      cid: string,
      action: "present" | "refresh" | "close",
      now: Date,
    ) => {
      const plan = await meter.pingSession(p1, action);
      if (!plan) throw new Error("no billing context for p1");
      const outcome = await presence.recordPing({ conversationId: cid, now, session: plan });
      await meter.settlePing(plan, p1, cid, now, outcome);
      return outcome;
    };
    const count = (now: Date) => presence.countActive(account, now);

    test("a registered conversation is counted in the ping's statement and the observer gets the count", async () => {
      const observed: number[] = [];
      const meter = meterWith(observed);
      const [a, b] = [await conversation(), await conversation()];
      const base = await count(at(0));
      await presence.registerConversation(account, a, at(0));
      await presence.registerConversation(account, b, at(0));
      expect(await meterPing(meter, a, "present", at(1))).toMatchObject({
        account,
        count: base + 1,
      });
      expect(await meterPing(meter, b, "present", at(2))).toMatchObject({
        account,
        count: base + 2,
      });
      // A repeat is a refresh of the same entry, not a second one.
      expect(await meterPing(meter, a, "present", at(3))).toMatchObject({ count: base + 2 });
      expect(observed).toEqual([base + 1, base + 2, base + 2]);
      expect(await count(at(3))).toBe(base + 2);
      await meterPing(meter, a, "close", at(4));
      await meterPing(meter, b, "close", at(4));
      expect(await count(at(4))).toBe(base);
    });

    test("winding down refreshes an entry but never creates one", async () => {
      const meter = meterWith();
      const cid = await conversation();
      await presence.registerConversation(account, cid, at(0));
      await meterPing(meter, cid, "refresh", at(1));
      expect(await sessions(cid)).toEqual([]);
      await meterPing(meter, cid, "present", at(2));
      await meterPing(meter, cid, "refresh", at(100));
      const [s] = await sessions(cid);
      expect(s?.seen_at.toISOString()).toBe(at(100).toISOString());
      // Counted within the two minute activity window of its last refresh.
      expect(await presence.countActive(account, at(100 + 119))).toBeGreaterThanOrEqual(1);
    });

    test("an unregistered conversation is verified once, then counted from the mapping", async () => {
      const meter = meterWith();
      const cid = await conversation();
      const out = await meterPing(meter, cid, "present", at(0));
      // The statement found no mapping; the slow path registered and counted it.
      expect(out.account).toBeNull();
      expect(await presence.accountForConversation(cid, at(1))).toBe(account);
      expect((await sessions(cid)).map((s) => s.scope)).toEqual([account]);
      expect((await meterPing(meter, cid, "present", at(3))).account).toBe(account);
    });

    test("a text or foreign conversation is marked once and never counted", async () => {
      const meter = meterWith();
      for (const cid of [text, foreign]) {
        await meterPing(meter, cid, "present", at(0));
        expect(await presence.accountForConversation(cid, at(1))).toBe(NEGATIVE_MARKER);
        // The marker is read back in the statement: no second conversation read.
        expect((await meterPing(meter, cid, "present", at(2))).account).toBe(NEGATIVE_MARKER);
        expect(await sessions(cid)).toEqual([]);
      }
    });
  });

  describe("route", () => {
    const settings = {
      participantTokenRequired: false,
      monitorEnabled: true,
      webhooksEnabled: false,
      dashboardUrl: "http://dashboard.test",
    };
    let d: ConversationsDeps;
    let app: Hono<Env>;
    let clock = T0;
    beforeAll(() => {
      d = {
        db: database.db,
        access: new Access(new DrizzleAccessStore(database.db)),
        audio: {} as ConversationsDeps["audio"],
        audioUrls: {} as ConversationsDeps["audioUrls"],
        jobs: { enqueue: async () => null },
        models: {} as ConversationsDeps["models"],
        media: {} as ConversationsDeps["media"],
        transcriber: {} as ConversationsDeps["transcriber"],
        hub,
        limiter: new RateLimiter(new MemoryRateCounter()),
        logger: quiet,
        tokens: new ParticipantTokens("s".repeat(48), true),
        settings,
        now: () => clock,
      };
      app = new Hono<Env>();
      app.route("/", liveRoutes(d));
    });
    const ping = async (cid: string, body: unknown, headers: Record<string, string> = {}) =>
      (await (
        await app.request(`/api/participant/conversations/${cid}/ping`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-participant-token": d.tokens.issue({ conversationId: cid, projectId: p1 }),
            ...headers,
          },
          body: JSON.stringify(body),
        })
      ).json()) as { ok: boolean };

    test("a recording ping stores liveness, stamps the conversation, indexes and counts it", async () => {
      const cid = await conversation();
      await presence.registerConversation(account, cid, clock);
      clock = new Date();
      const before = await liveRecordings(d).countActive(account);
      expect(await ping(cid, { project_id: p1, state: "recording", client_ts: 1 })).toEqual({
        ok: true,
      });
      const [conv] = await sql`select recording_started_at from conversation where id = ${cid}`;
      expect(conv?.recording_started_at).not.toBeNull();
      expect((await liveness(cid))?.data.recording_started_at).toBeString();
      expect(
        await presence.activeConversationIds(p1, new Date(clock.getTime() - 1000), clock),
      ).toContain(cid);
      expect(await liveRecordings(d).countActive(account)).toBe(before + 1);
      // Finished closes the meter entry and still refreshes liveness.
      expect(await ping(cid, { project_id: p1, state: "finished", client_ts: 2 })).toEqual({
        ok: true,
      });
      expect(await liveRecordings(d).countActive(account)).toBe(before);
      expect((await liveness(cid))?.data.state).toBe("finished");
    });

    test("a missing or wrong token stores and meters nothing", async () => {
      const cid = await conversation();
      clock = new Date();
      for (const token of ["", "p1.bad.sig"])
        expect(
          await ping(cid, { project_id: p1, state: "recording" }, { "x-participant-token": token }),
        ).toEqual({ ok: true });
      expect(await liveness(cid)).toBeUndefined();
      expect(await sessions(cid)).toEqual([]);
      expect(await presence.accountForConversation(cid, clock)).toBeNull();
    });

    test("a text-mode ping updates liveness but is never metered", async () => {
      const cid = await conversation();
      clock = new Date();
      await ping(cid, { project_id: p1, state: "recording", mode: "text" });
      expect((await liveness(cid))?.data.mode).toBe("text");
      expect(await presence.accountForConversation(cid, clock)).toBeNull();
      expect(await sessions(cid)).toEqual([]);
    });

    test("with the monitor off the meter still counts, and nothing else is written or nudged", async () => {
      const cid = await conversation();
      const nudges: unknown[] = [];
      const off = hub.subscribe([monitorChannel(p1)], (e) => nudges.push(e));
      settings.monitorEnabled = false;
      try {
        clock = new Date();
        await ping(cid, { project_id: p1, state: "recording" });
        expect(await liveness(cid)).toBeUndefined();
        expect(
          await presence.activeConversationIds(p1, new Date(clock.getTime() - 1000), clock),
        ).not.toContain(cid);
        expect((await sessions(cid)).map((s) => s.scope)).toEqual([account]);
        await Bun.sleep(200);
        expect(nudges).toEqual([]);
      } finally {
        settings.monitorEnabled = true;
        off();
      }
    });

    test("pings over the per-process limit from one address are dropped; another address is not", async () => {
      const cid = await conversation();
      clock = new Date();
      const flood = { "x-forwarded-for": "203.0.113.9" };
      // Fill the window cheaply: an absurd id passes the limiter and stores nothing.
      const long = "x".repeat(65);
      for (let i = 0; i < 6000; i++) await ping(long, null, flood);
      await ping(cid, { project_id: p1, state: "recording", client_ts: 7 }, flood);
      expect(await liveness(cid)).toBeUndefined();
      await ping(
        cid,
        { project_id: p1, state: "recording", client_ts: 8 },
        { "x-forwarded-for": "203.0.113.10" },
      );
      expect((await liveness(cid))?.data.client_ts).toBe(8);
      // The window resets after a minute.
      clock = new Date(clock.getTime() + 61_000);
      await ping(cid, { project_id: p1, state: "paused", client_ts: 9 }, flood);
      expect((await liveness(cid))?.data.state).toBe("paused");
    });
  });
});
