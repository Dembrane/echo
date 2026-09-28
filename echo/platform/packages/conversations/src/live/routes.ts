import { BadRequestError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { projectFor } from "@dembrane/projects";
import { boundedEventResponse, publish } from "@dembrane/realtime";
import { pythonJson } from "@dembrane/webhooks";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type postgres from "postgres";
import type { ConversationsDeps } from "../deps";
import { PARTICIPANT_TOKEN_HEADER } from "../participant-token";
import { isUuid } from "../storage";
import { RecordingMeter } from "./meter";
import {
  emptyMonitorPayload,
  gatherProjectMonitor,
  MONITOR_LIVE_WINDOW_SECONDS,
  type MonitorPayload,
  MonitorSnapshots,
  workspaceOverCapActive,
} from "./monitor";
import { Presence } from "./presence";
import {
  type ConversationPing,
  conversationPingModel,
  pingTelemetry,
  type VisitorPing,
  visitorPingModel,
  visitorTelemetry,
} from "./telemetry";

// Sized well above a large single-IP venue (phones ping every ~3s / ~10s).
const CONVERSATION_PING_LIMIT = {
  name: "participant_conversation_ping",
  capacity: 6000,
  windowSeconds: 60,
};
const VISITOR_PING_LIMIT = { name: "participant_visitor_ping", capacity: 3000, windowSeconds: 60 };
// Real ids are UUIDs; an absurd id must not bloat the presence table.
const MAX_PING_ID_LEN = 64;
const TERMINAL_PING_STATES = new Set(["left", "finished"]);
// Winding down: keep the entry warm but never re-add; the finish endpoint owns the close.
const WINDING_DOWN_PING_STATE = "finishing";
const MONITOR_STREAM_POLL_MS = 2000;
const HEALTH_INTERVAL_MS = 45_000;
const SSE_HEADERS = {
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "Content-Type": "text/event-stream; charset=utf-8",
};

/** The Postgres channel a project's monitor streams wait on. */
export const monitorChannel = (projectId: string) => `monitor:project:${projectId}`;

export interface LiveServices {
  readonly presence: Presence;
  readonly meter: RecordingMeter;
  readonly snapshots: MonitorSnapshots;
}

const services = new WeakMap<object, LiveServices>();

/** One presence store, meter and snapshot cache per database handle. */
export function liveServices(d: Pick<ConversationsDeps, "db" | "logger">): LiveServices {
  const hit = services.get(d.db);
  if (hit) return hit;
  const presence = new Presence(d.db);
  const made = {
    presence,
    meter: new RecordingMeter(d.db, presence, d.logger),
    snapshots: new MonitorSnapshots(),
  };
  services.set(d.db, made);
  return made;
}

/**
 * Nudges a project's open monitor streams to recompute (a ping, a transcription result,
 * a finish). Best effort, like the Redis publish it replaces.
 */
export async function publishMonitorDirty(db: Db, projectId: string): Promise<void> {
  if (!projectId) return;
  const sql = (db as unknown as { $client: postgres.Sql }).$client;
  await publish(sql, monitorChannel(projectId), { type: "dirty" });
}

/** First X-Forwarded-For hop, as the old API took it (spec hole L-20: trusts the header). */
function clientIp(c: Ctx): string {
  const fwd = c.req.header("x-forwarded-for");
  return fwd ? (fwd.split(",")[0]?.trim() ?? "unknown") : "unknown";
}

/** FastAPI's `body: Optional[Model] = None`: no body or JSON null is None, anything else is validated. */
// biome-ignore lint/suspicious/noExplicitAny: any model shape
async function optionalBody<T>(c: Ctx, m: p.Model<any>): Promise<T | null> {
  const text = await c.req.text();
  if (!text.trim()) return null;
  const { body } = await p.validate(c.req, { body: p.nullable(m) });
  return body ? ((body as p.Parsed<unknown>).data as T) : null;
}

/**
 * Whether the ping's participant token (Q7) holds. A ping must never disturb a
 * recording, so a missing (when required) or wrong token is not an error: the ping is
 * simply not trusted, and nothing is stored or metered.
 */
function tokenTrusted(d: ConversationsDeps, c: Ctx, conversationId: string): boolean {
  try {
    d.tokens.check(c.req.header(PARTICIPANT_TOKEN_HEADER), conversationId);
    return true;
  } catch {
    return false;
  }
}

async function stampRecordingStartedAt(
  d: ConversationsDeps,
  conversationId: string,
  stamp: string,
) {
  if (!isUuid(conversationId)) return;
  const sql = (d.db as unknown as { $client: postgres.Sql }).$client;
  // Server-clocked, so it may also correct a later client-stamped value. Uploads never stamp.
  await sql`
    update conversation set recording_started_at = ${stamp}, updated_at = ${d.now().toISOString()}
    where id = ${conversationId}
      and (source is null or source <> 'DASHBOARD_UPLOAD')
      and (recording_started_at is null or recording_started_at > ${stamp})`;
}

const windowQuery = (fallback: number) => ({
  project_id: p.required(p.str()),
  window_seconds: p.optional(p.int({ ge: 5, le: 600 }), fallback),
});

/**
 * Participant liveness pings, the pre-conversation funnel, the host monitor and its
 * stream, live counts, and the conversation health stream.
 */
export function liveRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();
  const live = () => liveServices(d);

  app.post("/api/participant/conversations/:conversation_id/ping", async (c) => {
    const conversationId = c.req.param("conversation_id");
    const body = await optionalBody<ConversationPing>(c, conversationPingModel);
    if (!tokenTrusted(d, c, conversationId)) return c.json({ ok: true });
    // Over the limit: drop the beacon and skip metering. Recording carries on.
    if (!(await d.limiter.allow(CONVERSATION_PING_LIMIT, clientIp(c)))) return c.json({ ok: true });
    const now = d.now();
    const { presence, meter } = live();
    const projectId = body?.project_id ?? null;
    if (
      body &&
      projectId &&
      projectId.length <= MAX_PING_ID_LEN &&
      conversationId.length <= MAX_PING_ID_LEN &&
      (body.mode || "voice") !== "text"
    ) {
      if (body.state && TERMINAL_PING_STATES.has(body.state))
        await meter.meter(projectId, conversationId, "close", now);
      // Never re-add while winding down: it races finish and would revive the entry.
      else if (body.state === WINDING_DOWN_PING_STATE)
        await meter.meter(projectId, conversationId, "refresh", now);
      else await meter.meter(projectId, conversationId, "present", now);
    }
    if (!d.settings.monitorEnabled) return c.json({ ok: true });
    if (conversationId.length > MAX_PING_ID_LEN) return c.json({ ok: true });
    try {
      const telemetry = pingTelemetry(body);
      const first = await presence.markConversationSeen(
        conversationId,
        Object.keys(telemetry).length ? telemetry : null,
        now,
      );
      if (first)
        await stampRecordingStartedAt(d, conversationId, first).catch((err) =>
          d.logger.warn(
            { err: (err as Error).message, conversationId },
            "recording_started_at stamp failed",
          ),
        );
    } catch (err) {
      d.logger.warn({ err: (err as Error).message, conversationId }, "liveness ping failed");
      return c.json({ ok: false });
    }
    if (body?.project_id && body.project_id.length <= MAX_PING_ID_LEN) {
      // Index the conversation as active so the monitor shows it before any chunk exists.
      await presence
        .registerActive(body.project_id, conversationId, now)
        .catch((err) =>
          d.logger.warn({ err: (err as Error).message }, "monitor active-index add failed"),
        );
      await publishMonitorDirty(d.db, body.project_id);
    }
    return c.json({ ok: true });
  });

  app.post("/api/participant/projects/:project_id/visitors/:visitor_id/ping", async (c) => {
    const projectId = c.req.param("project_id");
    const visitorId = c.req.param("visitor_id");
    const body = await optionalBody<VisitorPing>(c, visitorPingModel);
    // Monitor off, over the limit or an absurd id: drop the beacon, never disturb onboarding.
    if (!d.settings.monitorEnabled) return c.json({ ok: true });
    if (!(await d.limiter.allow(VISITOR_PING_LIMIT, clientIp(c)))) return c.json({ ok: true });
    if (projectId.length > MAX_PING_ID_LEN || visitorId.length > MAX_PING_ID_LEN)
      return c.json({ ok: true });
    try {
      const telemetry = visitorTelemetry(body);
      await live().presence.markVisitorSeen(
        projectId,
        visitorId,
        Object.keys(telemetry).length ? telemetry : null,
        d.now(),
      );
    } catch (err) {
      d.logger.warn({ err: (err as Error).message, projectId }, "visitor ping failed");
      return c.json({ ok: false });
    }
    await publishMonitorDirty(d.db, projectId);
    return c.json({ ok: true });
  });

  /** The cutoff for portal chunks (not dashboard uploads or clones) newer than the window. */
  const recentChunkConversations = async (windowSeconds: number) => {
    const sql = (d.db as unknown as { $client: postgres.Sql }).$client;
    const cutoff = new Date(d.now().getTime() - windowSeconds * 1000).toISOString();
    return { sql, cutoff };
  };

  app.get("/api/v2/bff/conversations/live", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: windowQuery(30) });
    await projectFor(d.access, who, query.project_id, "conversation:read");
    const { sql, cutoff } = await recentChunkConversations(query.window_seconds);
    // Directus read 200 chunks in primary-key order; the first chunk of each conversation wins.
    const rows = await sql<{ id: string; participant_name: string | null }[]>`
      select c.id, c.participant_name
      from conversation_chunk ch join conversation c on c.id = ch.conversation_id
      where c.project_id = ${query.project_id}
        and ch.source not in ('DASHBOARD_UPLOAD', 'CLONE') and ch.timestamp > ${cutoff}
      order by ch.id limit 200`;
    const out = new Map<string, { id: string; participant_name: string | null }>();
    for (const r of rows)
      if (!out.has(r.id)) out.set(r.id, { id: r.id, participant_name: r.participant_name });
    return c.json([...out.values()]);
  });

  const snapshot = async (
    projectId: string,
    windowSeconds: number,
    gate: { workspaceId: string | null; tier: string | null },
  ): Promise<MonitorPayload> => {
    // Recomputed per call so a mid-stream cap crossing starts gating.
    const overCapActive = await workspaceOverCapActive(d.db, gate.workspaceId, gate.tier);
    const { presence, snapshots } = live();
    return snapshots.get(`${projectId}:${windowSeconds}`, () =>
      gatherProjectMonitor(
        d.db,
        presence,
        d.logger,
        projectId,
        windowSeconds,
        { tier: gate.tier, overCapActive },
        d.now(),
      ),
    );
  };

  app.get("/api/v2/bff/conversations/monitor", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: windowQuery(MONITOR_LIVE_WINDOW_SECONDS) });
    const pa = await projectFor(d.access, who, query.project_id, "conversation:read");
    if (!d.settings.monitorEnabled) return c.json(emptyMonitorPayload(query.window_seconds));
    return c.json(
      await snapshot(query.project_id, query.window_seconds, {
        workspaceId: pa.project.workspaceId,
        tier: pa.tier,
      }),
    );
  });

  app.get("/api/v2/bff/conversations/monitor/stream", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: windowQuery(MONITOR_LIVE_WINDOW_SECONDS) });
    const pa = await projectFor(d.access, who, query.project_id, "conversation:read");
    for (const [k, v] of Object.entries(SSE_HEADERS)) c.header(k, v);
    const gate = { workspaceId: pa.project.workspaceId, tier: pa.tier };
    return boundedEventResponse(
      stream(c, async (s) => {
        let closed = false;
        let wake: (() => void) | null = null;
        s.onAbort(() => {
          closed = true;
          wake?.();
        });
        const sleep = (ms?: number) =>
          new Promise<void>((r) => {
            wake = r;
            if (ms !== undefined) setTimeout(r, ms);
          }).then(() => {
            wake = null;
          });
        if (!d.settings.monitorEnabled) {
          // Keep the connection stable (no EventSource reconnect loop) but do no work.
          await s.write(
            `event: snapshot\ndata: ${pythonJson(emptyMonitorPayload(query.window_seconds), { sortKeys: true })}\n\n`,
          );
          while (!closed) await sleep();
          return;
        }
        // A nudge (ping, transcription, finish) wakes the stream; the poll timeout is the safety net.
        const unsubscribe =
          d.hub?.subscribe([monitorChannel(query.project_id)], () => wake?.()) ?? (() => {});
        let last: string | null = null;
        try {
          while (!closed) {
            let serialized: string | null = null;
            try {
              serialized = pythonJson(
                await snapshot(query.project_id, query.window_seconds, gate),
                { sortKeys: true },
              );
            } catch (err) {
              d.logger.warn({ err: (err as Error).message }, "monitor stream snapshot failed");
            }
            if (serialized !== null && serialized !== last) {
              last = serialized;
              await s.write(`event: snapshot\ndata: ${serialized}\n\n`);
            }
            await sleep(MONITOR_STREAM_POLL_MS);
          }
        } finally {
          unsubscribe();
        }
      }),
      { signal: c.req.raw.signal },
    );
  });

  /**
   * Kept only for portal builds from before the portal stopped opening it, still open in
   * browsers during the rollout: it computes nothing, and every open one holds a request
   * slot. Bounded like every stream, so such a tab reconnects at most once per lifetime.
   * Remove it (with its parity scenarios and integration test) once request logs show no
   * hits on this path for seven days after the release without the stream.
   */
  app.get("/api/conversations/health/stream", async (c) => {
    const clean = (v: string | undefined) =>
      (v ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const conversationIds = clean(c.req.query("conversation_ids"));
    const projectIds = clean(c.req.query("project_ids"));
    if (!conversationIds.length && !projectIds.length)
      throw new BadRequestError("At least one of conversation_ids or project_ids must be provided");
    const total = conversationIds.length + projectIds.length;
    if (total > 20)
      throw new BadRequestError(`Too many IDs provided (${total}). Maximum allowed is 20.`);
    for (const [k, v] of Object.entries(SSE_HEADERS)) c.header(k, v);
    return boundedEventResponse(
      stream(c, async (s) => {
        let closed = false;
        let wake: (() => void) | null = null;
        s.onAbort(() => {
          closed = true;
          wake?.();
        });
        let pings = 0;
        let lastHealth: string | null = null;
        while (!closed) {
          pings++;
          await s.write(`event: ping\ndata: ${pings}\n\n`);
          if (conversationIds.length !== 1) {
            // Python raised inside its generator, caught it, and sent this before closing.
            await s.write(
              `event: error\ndata: ${pythonJson({ error: "Internal server error", timestamp: performance.now() / 1000 })}\n\n`,
            );
            return;
          }
          // No health signal is computed any more; the stream only proves the connection lives.
          const health = pythonJson({ conversation_issue: null });
          if (health !== lastHealth) {
            await s.write(`event: health_update\ndata: ${health}\n\n`);
            lastHealth = health;
          }
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, HEALTH_INTERVAL_MS);
          });
        }
      }),
      { signal: c.req.raw.signal },
    );
  });

  return app;
}

/** The billing port's LiveRecordings: live portal recordings per billing account. */
export function liveRecordings(d: Pick<ConversationsDeps, "db" | "logger">) {
  const { presence } = liveServices(d);
  return { countActive: (accountId: string) => presence.countActive(accountId) };
}
