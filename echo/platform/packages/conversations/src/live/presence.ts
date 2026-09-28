import type { Db } from "@dembrane/db";
import type postgres from "postgres";

/**
 * Presence state in one unlogged table (platform_presence), replacing the Redis keys of
 * conversation_liveness.py, visitor_session.py, monitor_stream.py and
 * recording_sessions.py. Each Redis key becomes a (kind, key) row with the key's TTL as
 * expires_at; a Redis sorted set becomes rows sharing a `scope`, scored by seen_at. An
 * expired row reads as absent, exactly like an expired key, and expired rows are pruned
 * now and then on write. Every operation is best-effort at the call site: presence must
 * never disturb a recording.
 */

// conversation_liveness: ~5s pings; ride out a few missed ones without flapping.
export const LIVENESS_TTL_SECONDS = 90;
// Non-capture states stay visible until the idle sweep finishes the conversation.
export const STICKY_STATE_TTL_SECONDS = 30 * 60;
const STICKY_STATES = new Set([
  "paused",
  "finishing",
  "verifying",
  "refining",
  "text",
  "backgrounded",
  "left",
]);
// visitor_session: ~10s pings while onboarding.
export const VISITOR_TTL_SECONDS = 45;
const VISITOR_INDEX_TTL_SECONDS = 2100;
const LINK_TTL_SECONDS = 120;
// monitor_stream: active-conversation index, a little longer than the monitor lookback.
const ACTIVE_TTL_SECONDS = 2100;
// A public flood of unique ids cannot grow a project's index past this.
const MAX_INDEX_MEMBERS = 2000;
// recording_sessions: entries not refreshed within the window stop counting.
export const ACTIVITY_WINDOW_SECONDS = 120;
const SESSION_TTL_SECONDS = 600;
const CONVERSATION_KEY_TTL_SECONDS = 86400;
export const NEGATIVE_MARKER = "-";
const NEGATIVE_TTL_SECONDS = 600;

const CONVERSATION_TELEMETRY = [
  "state",
  "mode",
  "screen",
  "network",
  "battery",
  "audio_level",
  "recorded_seconds",
  "segment_seconds",
  "client_ts",
] as const;
const VISITOR_TELEMETRY = [
  "stage",
  "name",
  "tags",
  "tags_preselected",
  "scan_count",
  "network",
  "battery",
  "device",
] as const;

export type Telemetry = Record<string, unknown>;

/** Python's datetime.isoformat() for an aware UTC instant: microseconds only when non-zero. */
export function pyIsoformat(d: Date): string {
  const base = d.toISOString();
  const ms = d.getUTCMilliseconds();
  return ms ? base.replace(/\.(\d{3})Z$/, ".$1000+00:00") : base.replace(/\.\d{3}Z$/, "+00:00");
}

/** conversation_liveness._parse_dt: an ISO string to a UTC Date, or null. */
export function parseSeen(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const raw = v.trim().replace(/Z$/, "+00:00");
  const withZone = /[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}+00:00`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Timestamps go to Postgres as ISO text: drizzle replaces the client's timestamp
// serialisers, so a Date parameter would not be sent in a form Postgres parses.
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000).toISOString();
const iso = (d: Date) => d.toISOString();
// The same client hands jsonb back as text; parse it where it is read.
const json = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
const obj = (v: unknown): Telemetry | null => {
  const o = json(v);
  return o && typeof o === "object" && !Array.isArray(o) ? (o as Telemetry) : null;
};

export class Presence {
  private readonly sql: postgres.Sql;
  private writes = 0;

  constructor(db: Db) {
    this.sql = (db as unknown as { $client: postgres.Sql }).$client;
  }

  private async get(kind: string, key: string, now: Date) {
    const [row] = await this.sql<{ data: unknown; seen_at: Date }[]>`
      select data, seen_at from platform_presence
      where kind = ${kind} and key = ${key} and expires_at > ${iso(now)}`;
    return row ? { ...row, data: json(row.data) } : null;
  }

  private async put(
    kind: string,
    key: string,
    scope: string,
    data: unknown,
    seenAt: Date,
    ttlSeconds: number,
  ): Promise<void> {
    await this.sql`
      insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
      values (${kind}, ${key}, ${scope}, ${data === null ? null : JSON.stringify(data)}::jsonb,
              ${iso(seenAt)}, ${addSeconds(seenAt, ttlSeconds)})
      on conflict (kind, key) do update set
        scope = excluded.scope, data = excluded.data,
        seen_at = excluded.seen_at, expires_at = excluded.expires_at`;
    await this.prune(seenAt);
  }

  /** Expired rows are invisible already; deleting them every few hundred writes keeps the table small. */
  private async prune(now: Date): Promise<void> {
    if (++this.writes % 200 !== 0) return;
    await this.sql`delete from platform_presence where expires_at <= ${iso(now)}`;
  }

  /** Newest members of an index scoped to one project, since `since`. */
  private async members(kind: string, scope: string, since: Date, now: Date): Promise<string[]> {
    const rows = await this.sql<{ key: string }[]>`
      select key from platform_presence
      where kind = ${kind} and scope = ${scope} and seen_at >= ${iso(since)} and expires_at > ${iso(now)}
      order by seen_at desc limit ${MAX_INDEX_MEMBERS}`;
    const prefix = `${scope}:`;
    return rows.map((r) => (r.key.startsWith(prefix) ? r.key.slice(prefix.length) : r.key));
  }

  // ── participant liveness (conversation_liveness.mark_conversation_seen) ──

  /**
   * Stores the latest ping. An out-of-order ping (older client_ts) is dropped so a late
   * one cannot clobber a newer state such as "left". The first "recording" ping stamps
   * recording_started_at (server time) and later pings carry it forward. Returns that
   * stamp when this ping was the first recording one, so the caller persists it.
   */
  async markConversationSeen(
    conversationId: string,
    telemetry: Telemetry | null,
    now: Date,
  ): Promise<string | null> {
    const payload: Telemetry = { seen: pyIsoformat(now) };
    if (telemetry)
      for (const f of CONVERSATION_TELEMETRY)
        if (telemetry[f] !== undefined && telemetry[f] !== null) payload[f] = telemetry[f];
    const ttl = STICKY_STATES.has(String(payload.state))
      ? STICKY_STATE_TTL_SECONDS
      : LIVENESS_TTL_SECONDS;
    return this.sql.begin(async (tx) => {
      // Serialise concurrent pings of one conversation, as Redis's single thread did.
      await tx`select pg_advisory_xact_lock(hashtext(${`liveness:${conversationId}`}))`;
      const [row] = await tx<{ data: Telemetry | null }[]>`
        select data from platform_presence
        where kind = 'liveness' and key = ${conversationId} and expires_at > ${iso(now)}`;
      const existing = obj(row?.data);
      const incoming = payload.client_ts;
      if (Number.isInteger(incoming) && existing) {
        const prev = existing.client_ts;
        if (Number.isInteger(prev) && (incoming as number) < (prev as number)) return null;
      }
      let first: string | null = null;
      if (existing?.recording_started_at)
        payload.recording_started_at = existing.recording_started_at;
      else if (payload.state === "recording") {
        payload.recording_started_at = payload.seen;
        first = payload.seen as string;
      }
      await tx`
        insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
        values ('liveness', ${conversationId}, '', ${JSON.stringify(payload)}::jsonb, ${iso(now)},
                ${addSeconds(now, ttl)})
        on conflict (kind, key) do update set
          data = excluded.data, seen_at = excluded.seen_at, expires_at = excluded.expires_at`;
      return first;
    }) as Promise<string | null>;
  }

  /** get_telemetry_many: {conversation_id: telemetry with a `seen` Date} for live pings. */
  async telemetryMany(conversationIds: readonly string[], now: Date) {
    const out = new Map<string, Telemetry & { seen: Date }>();
    if (!conversationIds.length) return out;
    const rows = await this.sql<{ key: string; data: Telemetry | null }[]>`
      select key, data from platform_presence
      where kind = 'liveness' and key = any(${conversationIds as string[]}) and expires_at > ${iso(now)}`;
    for (const r of rows) {
      const data = obj(r.data);
      const seen = data && parseSeen(data.seen);
      if (data && seen) out.set(r.key, { ...data, seen });
    }
    return out;
  }

  // ── monitor active index (monitor_stream) ──

  async registerActive(projectId: string, conversationId: string, now: Date): Promise<void> {
    if (!projectId || !conversationId) return;
    await this.put(
      "active",
      `${projectId}:${conversationId}`,
      projectId,
      null,
      now,
      ACTIVE_TTL_SECONDS,
    );
  }

  activeConversationIds(projectId: string, since: Date, now: Date) {
    return this.members("active", projectId, since, now);
  }

  // ── visitor funnel (visitor_session) ──

  /** mark_visitor_seen: accumulates a first-seen time per funnel stage across pings. */
  async markVisitorSeen(
    projectId: string,
    visitorId: string,
    telemetry: Telemetry | null,
    now: Date,
  ): Promise<void> {
    if (!projectId || !visitorId) return;
    const seenIso = pyIsoformat(now);
    const payload: Telemetry = { seen: seenIso, id: visitorId };
    if (telemetry)
      for (const f of VISITOR_TELEMETRY)
        if (telemetry[f] !== undefined && telemetry[f] !== null) payload[f] = telemetry[f];
    const key = `${projectId}:${visitorId}`;
    const existing = (await this.get("visitor", key, now))?.data as Telemetry | null | undefined;
    const stages: Record<string, unknown> =
      existing?.stages && typeof existing.stages === "object" && !Array.isArray(existing.stages)
        ? { ...(existing.stages as Record<string, unknown>) }
        : {};
    const firstSeen = typeof existing?.first_seen === "string" ? existing.first_seen : seenIso;
    if (typeof payload.stage === "string" && !(payload.stage in stages))
      stages[payload.stage] = seenIso;
    payload.stages = stages;
    payload.first_seen = firstSeen;
    await this.put("visitor", key, projectId, payload, now, VISITOR_TTL_SECONDS);
    await this.put("visitor_index", key, projectId, null, now, VISITOR_INDEX_TTL_SECONDS);
  }

  activeVisitorIds(projectId: string, since: Date, now: Date) {
    return this.members("visitor_index", projectId, since, now);
  }

  async visitorsMany(projectId: string, visitorIds: readonly string[], now: Date) {
    const out = new Map<string, Telemetry & { seen: Date }>();
    if (!visitorIds.length) return out;
    const keys = visitorIds.map((v) => `${projectId}:${v}`);
    const rows = await this.sql<{ key: string; data: Telemetry | null }[]>`
      select key, data from platform_presence
      where kind = 'visitor' and key = any(${keys}) and expires_at > ${iso(now)}`;
    for (const r of rows) {
      const data = obj(r.data);
      const seen = data && parseSeen(data.seen);
      if (data && seen) out.set(r.key.slice(projectId.length + 1), { ...data, seen });
    }
    return out;
  }

  /** link_visitor_conversation: a short bridge from initiate to the first ping. */
  async linkVisitorConversation(
    visitorId: string | null,
    conversationId: string | null,
    now: Date,
  ) {
    if (!visitorId || !conversationId) return;
    await this.put("visitor_link", visitorId, "", conversationId, now, LINK_TTL_SECONDS);
  }

  async linkedVisitorIds(visitorIds: readonly string[], now: Date): Promise<Set<string>> {
    if (!visitorIds.length) return new Set();
    const rows = await this.sql<{ key: string }[]>`
      select key from platform_presence
      where kind = 'visitor_link' and key = any(${visitorIds as string[]}) and expires_at > ${iso(now)}`;
    return new Set(rows.map((r) => r.key));
  }

  // ── concurrent recording meter (recording_sessions) ──

  async registerConversation(accountId: string, conversationId: string, now: Date) {
    if (!accountId || !conversationId) return;
    await this.put("rec_conv", conversationId, "", accountId, now, CONVERSATION_KEY_TTL_SECONDS);
  }

  async registerNegative(conversationId: string, now: Date) {
    if (!conversationId) return;
    await this.put("rec_conv", conversationId, "", NEGATIVE_MARKER, now, NEGATIVE_TTL_SECONDS);
  }

  /** The account a conversation was registered under; null on a miss, "-" when checked and foreign. */
  async accountForConversation(conversationId: string, now: Date): Promise<string | null> {
    if (!conversationId) return null;
    const row = await this.get("rec_conv", conversationId, now);
    return typeof row?.data === "string" ? row.data : null;
  }

  /** record_presence: add or refresh, then the live count. */
  async recordPresence(accountId: string, conversationId: string, now: Date): Promise<number> {
    if (!accountId || !conversationId) return 0;
    await this.put("rec_session", conversationId, accountId, null, now, SESSION_TTL_SECONDS);
    return this.countActive(accountId, now);
  }

  /** refresh_if_present: refresh an existing entry; never creates one. */
  async refreshIfPresent(accountId: string, conversationId: string, now: Date): Promise<void> {
    if (!accountId || !conversationId) return;
    await this.sql`
      update platform_presence set seen_at = ${iso(now)}, expires_at = ${addSeconds(now, SESSION_TTL_SECONDS)}
      where kind = 'rec_session' and key = ${conversationId} and scope = ${accountId}
        and expires_at > ${iso(now)}`;
  }

  async closeSession(accountId: string, conversationId: string): Promise<void> {
    if (!accountId || !conversationId) return;
    await this.sql`
      delete from platform_presence
      where kind = 'rec_session' and key = ${conversationId} and scope = ${accountId}`;
  }

  /** count_active: live portal recordings of one billing account. */
  async countActive(accountId: string, now: Date = new Date()): Promise<number> {
    if (!accountId) return 0;
    const [row] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from platform_presence
      where kind = 'rec_session' and scope = ${accountId}
        and seen_at >= ${addSeconds(now, -ACTIVITY_WINDOW_SECONDS)} and expires_at > ${iso(now)}`;
    return row?.n ?? 0;
  }
}
