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

/** What one participant ping writes; see Presence.recordPing. */
export interface PingWrite {
  readonly conversationId: string;
  readonly now: Date;
  /** The liveness row; absent with the monitor off. */
  readonly liveness?: { readonly telemetry: Telemetry | null } | null;
  /** Index the conversation as active under this project (the monitor's ping-only rows). */
  readonly activeProjectId?: string | null;
  /** The recording meter's part: the session row of this billing account. */
  readonly session?: {
    readonly accountId: string;
    readonly action: "present" | "refresh" | "close";
    /** Also return the account's live count after this ping (for the overage observer). */
    readonly count: boolean;
  } | null;
  /** A pg_notify to send on commit (realtime's notification()). */
  readonly notify?: { readonly pgChannel: string; readonly payload: string } | null;
}

export interface PingOutcome {
  /** The recording start this ping stamped, when it was the first recording ping. */
  readonly first: string | null;
  /** The account the conversation is registered under ("-" when foreign); null when unregistered. */
  readonly account: string | null;
  /** The account's live recordings after this ping, when asked for and the session was written. */
  readonly count: number | null;
}

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

  /**
   * Expired rows are invisible already; deleting them every few hundred writes keeps the
   * table small. Rows a ping holds are skipped: a ping locks several rows in one statement,
   * and a prune waiting on them in another order could deadlock with it.
   */
  private async prune(now: Date): Promise<void> {
    if (++this.writes % 200 !== 0) return;
    await this.sql`
      delete from platform_presence where ctid in (
        select ctid from platform_presence where expires_at <= ${iso(now)} for update skip locked)`;
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
    return (await this.recordPing({ conversationId, now, liveness: { telemetry } })).first;
  }

  // ── the participant ping, in one statement ──

  /**
   * Everything a participant ping writes, as one statement and one round trip: the
   * liveness row (markConversationSeen's rules, with the row lock of the upsert
   * serialising concurrent pings of one conversation), the monitor's active index, the
   * recording meter's session row, and the monitor nudge, sent on commit. Each part is
   * optional. The meter part only acts when the conversation's account mapping exists and
   * matches; otherwise `account` comes back null (no mapping) or foreign, and the meter
   * takes its slow path.
   */
  async recordPing(ping: PingWrite): Promise<PingOutcome> {
    const { conversationId, now } = ping;
    const nowIso = iso(now);
    let payload: Telemetry | null = null;
    let liveUntil: string | null = null;
    let clientTs: string | null = null;
    if (ping.liveness) {
      payload = { seen: pyIsoformat(now) };
      const t = ping.liveness.telemetry;
      if (t)
        for (const f of CONVERSATION_TELEMETRY)
          if (t[f] !== undefined && t[f] !== null) payload[f] = t[f];
      liveUntil = addSeconds(
        now,
        STICKY_STATES.has(String(payload.state)) ? STICKY_STATE_TTL_SECONDS : LIVENESS_TTL_SECONDS,
      );
      if (Number.isInteger(payload.client_ts)) clientTs = String(payload.client_ts);
    }
    const seen = (payload?.seen as string | undefined) ?? null;
    const recording = payload?.state === "recording";
    const project = ping.activeProjectId || null;
    const activeKey = project && conversationId ? `${project}:${conversationId}` : null;
    const session = ping.session?.accountId && conversationId ? ping.session : null;
    const action = session?.action ?? null;
    const account = session?.accountId ?? null;
    const notify = ping.notify ?? null;
    const [row] = await this.sql<
      {
        started: string | null;
        stored: boolean;
        prev_started: boolean;
        known: boolean;
        account: string | null;
        count: number | null;
      }[]
    >`
      with conv as (
        select case when jsonb_typeof(data) = 'string' then data #>> '{}' end as account
        from platform_presence
        where ${action}::text in ('present', 'refresh')
          and kind = 'rec_conv' and key = ${conversationId} and expires_at > ${nowIso}
      ),
      sess as (
        insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
        select 'rec_session', ${conversationId}::text, ${account}::text, null::jsonb, ${nowIso}::timestamptz,
          ${addSeconds(now, SESSION_TTL_SECONDS)}::timestamptz
        where ${action}::text = 'present' and exists (select 1 from conv where account = ${account}::text)
        on conflict (kind, key) do update set
          scope = excluded.scope, data = excluded.data,
          seen_at = excluded.seen_at, expires_at = excluded.expires_at
        returning 1
      ),
      refreshed as (
        update platform_presence set seen_at = ${nowIso}, expires_at = ${addSeconds(now, SESSION_TTL_SECONDS)}
        where ${action}::text = 'refresh' and exists (select 1 from conv where account = ${account}::text)
          and kind = 'rec_session' and key = ${conversationId} and scope = ${account}::text
          and expires_at > ${nowIso}
        returning 1
      ),
      closed as (
        delete from platform_presence
        where ${action}::text = 'close'
          and kind = 'rec_session' and key = ${conversationId} and scope = ${account}::text
        returning 1
      ),
      prev as (
        select data from platform_presence
        where ${payload !== null} and kind = 'liveness' and key = ${conversationId}
          and expires_at > ${nowIso}
      ),
      live as (
        insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
        select 'liveness', ${conversationId}::text, '',
          ${payload === null ? null : JSON.stringify(payload)}::jsonb
            || case when ${recording} then jsonb_build_object('recording_started_at', ${seen}::text)
               else '{}'::jsonb end,
          ${nowIso}::timestamptz, ${liveUntil}::timestamptz
        where ${payload !== null}
        on conflict (kind, key) do update set
          data = case
            when platform_presence.expires_at > ${nowIso}
              and jsonb_typeof(platform_presence.data -> 'recording_started_at') = 'string'
              and platform_presence.data ->> 'recording_started_at' <> ''
            then ${payload === null ? null : JSON.stringify(payload)}::jsonb
              || jsonb_build_object('recording_started_at', platform_presence.data -> 'recording_started_at')
            else excluded.data end,
          seen_at = excluded.seen_at, expires_at = excluded.expires_at
        where not coalesce(
          platform_presence.expires_at > ${nowIso}
          and ${clientTs}::numeric is not null
          and case when jsonb_typeof(platform_presence.data -> 'client_ts') = 'number' then
            (platform_presence.data ->> 'client_ts')::numeric
              = trunc((platform_presence.data ->> 'client_ts')::numeric)
            and ${clientTs}::numeric < (platform_presence.data ->> 'client_ts')::numeric
          else false end,
          false)
        returning data ->> 'recording_started_at' as started
      ),
      active as (
        insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
        select 'active', ${activeKey}::text, ${project}::text, null::jsonb, ${nowIso}::timestamptz,
          ${addSeconds(now, ACTIVE_TTL_SECONDS)}::timestamptz
        where ${activeKey}::text is not null
        on conflict (kind, key) do update set
          scope = excluded.scope, data = excluded.data,
          seen_at = excluded.seen_at, expires_at = excluded.expires_at
        returning 1
      )
      select
        (select started from live) as started,
        exists (select 1 from live) as stored,
        exists (
          select 1 from prev
          where jsonb_typeof(data -> 'recording_started_at') = 'string'
            and data ->> 'recording_started_at' <> ''
        ) as prev_started,
        exists (select 1 from conv) as known,
        (select account from conv) as account,
        case when ${Boolean(session?.count)} and exists (select 1 from sess) then (
          select count(*)::int + 1 from platform_presence
          where kind = 'rec_session' and scope = ${account}::text and key <> ${conversationId}
            and seen_at >= ${addSeconds(now, -ACTIVITY_WINDOW_SECONDS)} and expires_at > ${nowIso}
        ) end as count,
        (select count(*) from sess) + (select count(*) from refreshed) + (select count(*) from closed)
          + (select count(*) from active) as _writes,
        case when ${notify?.pgChannel ?? null}::text is not null
          then pg_notify(${notify?.pgChannel ?? null}::text, ${notify?.payload ?? null}::text) end as _nudge`;
    await this.prune(now);
    const first =
      row?.stored && recording && !row.prev_started && row.started === seen ? seen : null;
    return {
      first,
      account: row?.known ? (row.account ?? null) : null,
      count: row?.count ?? null,
    };
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
    // The client hands a jsonb string back already decoded, so read it as text here.
    const [row] = await this.sql<{ account: string | null }[]>`
      select case when jsonb_typeof(data) = 'string' then data #>> '{}' end as account
      from platform_presence
      where kind = 'rec_conv' and key = ${conversationId} and expires_at > ${iso(now)}`;
    return row?.account ?? null;
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
