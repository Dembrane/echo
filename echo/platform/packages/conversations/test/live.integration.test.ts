import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@echo/access";
import { PlatformError } from "@echo/core";
import { createDb, migrate } from "@echo/db";
import type { Env, Signed } from "@echo/http";
import { createLogger } from "@echo/observability";
import { MemoryRateCounter, RateLimiter } from "@echo/ratelimit";
import { Hub } from "@echo/realtime";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { liveRecordings, liveRoutes, liveServices } from "../src/live/routes";
import { ParticipantTokens } from "../src/participant-token";

/**
 * Runs against a copy of the parity seed: what parity cannot compare (streams, presence
 * kept in Redis on the old side, the recording meter), end to end through the routes.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = "parity_template_platform";
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
const c1 = id("c1", 1);
const c2 = id("c1", 2);
const DB = "conv_live_test";
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

async function readUntil(
  body: ReadableStream<Uint8Array>,
  done: (text: string) => boolean,
  ms = 10_000,
) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const end = Date.now() + ms;
  while (!done(text)) {
    if (Date.now() > end) throw new Error(`timed out; got:\n${text}`);
    const r = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, end - Date.now())).then(() => ({ done: true, value: undefined })),
    ]);
    if (r.done) break;
    text += dec.decode(r.value);
  }
  await reader.cancel();
  return text;
}

run("live presence, monitor and streams", () => {
  setDefaultTimeout(30_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let listener: postgres.Sql;
  let hub: Hub;
  let d: ConversationsDeps;
  let app: Hono<Env>;
  const settings = {
    participantTokenRequired: false,
    monitorEnabled: true,
    webhooksEnabled: false,
    dashboardUrl: "http://dashboard.test",
  };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    await migrate(`${base}/${DB}`);
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    listener = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    hub = new Hub(listener, quiet);
    await hub.start();
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
      tokens: new ParticipantTokens("s".repeat(48), false),
      settings,
      now: () => new Date(),
    };
    // No 3 second snapshot cache here: each read must see the ping just made.
    liveServices(d).snapshots.get = (_k, compute) => compute();
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", c.req.header("x-as") === "alice" ? alice : null);
      c.set("logger", quiet);
      await next();
    });
    app.route("/", liveRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await hub.stop();
    await Promise.allSettled([sql.end(), listener.end(), database.close()]);
  });

  const ping = (cid: string, body: unknown) =>
    app.request(`/api/participant/conversations/${cid}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const monitor = async () =>
    (await (
      await app.request(`/api/v2/bff/conversations/monitor?project_id=${p1}`, {
        headers: { "x-as": "alice" },
      })
    ).json()) as {
      conversations: Record<string, unknown>[];
      funnel: { visitors: Record<string, unknown>[]; summary: Record<string, number> };
    };

  test("a recording ping is stored, stamps the start once, and an older ping cannot overwrite it", async () => {
    expect(
      await (
        await ping(c2, { project_id: p1, state: "recording", client_ts: 10, audio_level: 0.5 })
      ).json(),
    ).toEqual({ ok: true });
    const [row] = await sql`select recording_started_at from conversation where id = ${c2}`;
    expect(row?.recording_started_at).not.toBeNull();
    const first = await liveServices(d).presence.telemetryMany([c2], new Date());
    const started = first.get(c2)?.recording_started_at;
    expect(first.get(c2)?.state).toBe("recording");
    await ping(c2, { project_id: p1, state: "paused", client_ts: 5 });
    const after = await liveServices(d).presence.telemetryMany([c2], new Date());
    expect(after.get(c2)?.state).toBe("recording");
    await ping(c2, { project_id: p1, state: "paused", client_ts: 20 });
    const paused = await liveServices(d).presence.telemetryMany([c2], new Date());
    expect(paused.get(c2)?.state).toBe("paused");
    expect(paused.get(c2)?.recording_started_at).toBe(started);
    // Paused is sticky: the entry outlives the 90 second liveness TTL.
    const later = await liveServices(d).presence.telemetryMany(
      [c2],
      new Date(Date.now() + 10 * 60_000),
    );
    expect(later.has(c2)).toBe(true);
  });

  test("the monitor shows a session that pings before any chunk, with its telemetry", async () => {
    await ping(c2, {
      project_id: p1,
      state: "recording",
      client_ts: 30,
      audio_level: 0.25,
      visitor_id: "v-9",
    });
    const m = await monitor();
    const row = m.conversations.find((c) => c.id === c2);
    expect(row).toMatchObject({
      state: "recording",
      is_live: true,
      audio_level: 0.25,
      chunk_count: 1,
    });
    expect(typeof row?.last_seen_at).toBe("string");
  });

  test("visitors appear in the funnel until they graduate", async () => {
    const visit = await app.request(`/api/participant/projects/${p1}/visitors/v-1/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "terms", name: "Ada" }),
    });
    expect(await visit.json()).toEqual({ ok: true });
    let m = await monitor();
    expect(m.funnel.visitors.map((v) => v.id)).toContain("v-1");
    expect(m.funnel.visitors.find((v) => v.id === "v-1")).toMatchObject({
      stage: "terms",
      name: "Ada",
    });
    await liveServices(d).presence.linkVisitorConversation("v-1", c2, new Date());
    m = await monitor();
    expect(m.funnel.visitors.map((v) => v.id)).not.toContain("v-1");
  });

  test("audio pings count toward the billing account's live recordings; a terminal ping closes", async () => {
    const [ws] =
      await sql`select w.billing_account_id from project p join workspace w on w.id = p.workspace_id where p.id = ${p1}`;
    const account = String(ws?.billing_account_id);
    const recordings = liveRecordings(d);
    expect(await recordings.countActive(account)).toBe(0);
    await ping(c1, { project_id: p1, state: "recording", mode: "voice" });
    expect(await recordings.countActive(account)).toBe(1);
    // A text conversation is never metered, whatever the ping says.
    await ping(c2, { project_id: p1, state: "recording", mode: "voice" });
    expect(await recordings.countActive(account)).toBe(1);
    await ping(c1, { project_id: p1, state: "left", mode: "voice" });
    expect(await recordings.countActive(account)).toBe(0);
  });

  test("a wrong participant token is not trusted: ok, but nothing is stored", async () => {
    const res = await app.request(`/api/participant/conversations/${c1}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-participant-token": "p1.bad.sig" },
      body: JSON.stringify({ project_id: p1, state: "verifying", client_ts: 999 }),
    });
    expect(await res.json()).toEqual({ ok: true });
    const t = await liveServices(d).presence.telemetryMany([c1], new Date());
    expect(t.get(c1)?.state).not.toBe("verifying");
  });

  test("the monitor stream sends a snapshot and another when a ping changes it", async () => {
    const res = await app.request(`/api/v2/bff/conversations/monitor/stream?project_id=${p1}`, {
      headers: { "x-as": "alice" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = res.body as ReadableStream<Uint8Array>;
    setTimeout(() => void ping(c2, { project_id: p1, state: "verifying", client_ts: 5000 }), 300);
    const text = await readUntil(body, (t) => (t.match(/event: snapshot/g) ?? []).length >= 2);
    const first = JSON.parse(text.split("\n")[1]?.slice("data: ".length) ?? "{}");
    expect(Object.keys(first)).toEqual([
      "conversations",
      "funnel",
      "live_window_seconds",
      "summary",
    ]);
    expect(text).toContain('"state": "verifying"');
  });

  test("the health stream pings and reports no issue for one conversation", async () => {
    const res = await app.request(`/api/conversations/health/stream?conversation_ids=${c1}`);
    const text = await readUntil(res.body as ReadableStream<Uint8Array>, (t) =>
      t.includes("health_update"),
    );
    expect(text).toBe(
      'event: ping\ndata: 1\n\nevent: health_update\ndata: {"conversation_issue": null}\n\n',
    );
    const many = await app.request(`/api/conversations/health/stream?project_ids=${p1}`);
    const err = await readUntil(many.body as ReadableStream<Uint8Array>, (t) =>
      t.includes("event: error"),
    );
    expect(err).toMatch(
      /^event: ping\ndata: 1\n\nevent: error\ndata: \{"error": "Internal server error", "timestamp": /,
    );
  });

  test("with the monitor switched off, pings store nothing and the monitor is empty", async () => {
    settings.monitorEnabled = false;
    try {
      await ping(c1, { project_id: p1, state: "finishing", client_ts: 9000 });
      const t = await liveServices(d).presence.telemetryMany([c1], new Date());
      expect(t.get(c1)?.state).not.toBe("finishing");
      const m = await monitor();
      expect(m.conversations).toEqual([]);
      expect(m.funnel.summary.total).toBe(0);
    } finally {
      settings.monitorEnabled = true;
    }
  });
});
