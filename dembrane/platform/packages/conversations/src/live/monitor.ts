import type { Db } from "@dembrane/db";
import { isoTimestamp } from "@dembrane/legacy-shape";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { type Presence, pyIsoformat, type Telemetry } from "./presence";
import { VALID_PARTICIPANT_STATES, VALID_VISITOR_STAGES } from "./telemetry";

/**
 * The host monitor (api/v2/bff/conversations.py gather_project_monitor and
 * _build_monitor_payload): recent portal chunks, sessions that ping before their first
 * chunk, per-conversation transcription progress, tags, participant telemetry and the
 * pre-conversation funnel, folded into one payload. The builder is pure so the state
 * rules are testable without a database.
 */

export const MONITOR_LIVE_WINDOW_SECONDS = 45;
const MONITOR_LOOKBACK_SECONDS = 1800;
const MONITOR_MAX_CHUNKS = 500;
const MONITOR_ERROR_MESSAGE_MAX_LEN = 240;
const MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN = 280;
const MONITOR_HEARTBEAT_GRACE_SECONDS = 15;
const MONITOR_CONTACT_CHUNK_SECONDS = 60;
const MONITOR_RECORDING_STALL_SECONDS = 45;
const MONITOR_RESUME_GRACE_SECONDS = MONITOR_RECORDING_STALL_SECONDS;
const MONITOR_TRANSCRIBE_SECONDS_PER_CLIP = 20;
const FUNNEL_STAGES = ["scanned", "terms", "profile"] as const;
// Stages written by portals from before the microphone check was removed; they passed consent.
const RETIRED_MIC_STAGES = new Set(["mic_ok", "mic_skipped", "mic_blocked"]);
const PORTAL_ONLY = ["DASHBOARD_UPLOAD", "CLONE"];
// tier_capacity: paid tiers are never hour capped; free has a one-hour lifetime cap.
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
const INCLUDED_HOURS: Record<string, number | null> = {
  free: 1,
  innovator: null,
  changemaker: null,
  guardian: null,
};

const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join("");

export interface ChunkRow {
  readonly conversation_id: string;
  readonly participant_name: string | null;
  readonly is_finished: boolean | null;
  readonly created_at: string | null;
  readonly duration: number | null;
  readonly is_over_cap: boolean | null;
  readonly timestamp: string | null;
  readonly error: string | null;
  readonly transcript: string | null;
  readonly detected_language: string | null;
  readonly desired_language: string | null;
}

export interface ExtraConversation {
  readonly id: string;
  readonly participant_name: string | null;
  readonly is_finished: boolean | null;
  readonly created_at: string | null;
  readonly duration: number | null;
  readonly is_over_cap: boolean | null;
}

type Tele = Telemetry & { seen: Date };

/** tier_capacity.is_conversation_locked plus the live gate for still-recording rows. */
export function conversationLocked(
  conv: { is_over_cap?: unknown; is_finished?: unknown },
  tier: string | null,
  overCapActive: boolean,
): boolean {
  if (conv.is_over_cap && tier !== null && !OVERAGE_TIERS.has(tier)) return true;
  return overCapActive && !conv.is_finished;
}

export function monitorStatus(a: {
  isFinished: boolean;
  reportedState: unknown;
  pingFresh: boolean;
  contactFresh: boolean;
  audioFresh: boolean;
  chunkCount: number;
  segmentSeconds?: unknown;
}): [string, string] {
  const { reportedState } = a;
  if (a.isFinished) return ["finished", "finished"];
  if (reportedState === "left") return ["left", "left"];
  if (reportedState === "backgrounded") return ["backgrounded", "backgrounded"];
  if (!a.contactFresh) {
    if (reportedState === "recording" || (!reportedState && a.chunkCount > 0))
      return ["offline", "offline"];
    if (reportedState) return ["left", "left"];
    return ["initiated", "waiting"];
  }
  let state: string;
  if (typeof reportedState === "string" && VALID_PARTICIPANT_STATES.has(reportedState))
    state = reportedState;
  else if (a.audioFresh) state = "recording";
  else if (a.chunkCount > 0) state = "idle";
  else state = "initiated";
  const withinResumeGrace =
    typeof a.segmentSeconds === "number" && a.segmentSeconds < MONITOR_RESUME_GRACE_SECONDS;
  let health: string;
  if (reportedState === "paused") health = "paused";
  else if (a.audioFresh) health = "receiving";
  else if (a.pingFresh && a.chunkCount > 0 && !withinResumeGrace) health = "stalled";
  else if (a.chunkCount > 0) health = withinResumeGrace ? "receiving" : "idle";
  else health = "waiting";
  return [state, health];
}

function transcriptionStatus(hasError: boolean, chunkCount: number, transcribed: number): string {
  if (chunkCount <= 0) return "idle";
  if (hasError) return "failing";
  return chunkCount - transcribed > 0 ? "transcribing" : "up_to_date";
}

function parseTs(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const raw = v.trim().replace(/Z$/, "+00:00");
  const d = new Date(/[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}+00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeline(
  stages: unknown,
  createdAt: unknown,
  recordingStartedAt: unknown,
  lastChunkAt: unknown,
) {
  const steps: { key: string; at: string }[] = [];
  if (stages && typeof stages === "object" && !Array.isArray(stages))
    for (const stage of FUNNEL_STAGES) {
      const at = (stages as Record<string, unknown>)[stage];
      if (typeof at === "string" && at.trim()) steps.push({ key: stage, at });
    }
  if (typeof createdAt === "string" && createdAt.trim())
    steps.push({ key: "created", at: createdAt });
  if (typeof recordingStartedAt === "string" && recordingStartedAt.trim())
    steps.push({ key: "recording_started", at: recordingStartedAt });
  if (typeof lastChunkAt === "string" && lastChunkAt.trim())
    steps.push({ key: "last_audio", at: lastChunkAt });
  return steps;
}

interface Entry {
  id: string;
  label: string | null;
  is_finished: boolean;
  last_chunk_at: string | null;
  last_chunk_dt: Date | null;
  has_error: boolean;
  error_message: string | null;
  latest_transcript: string | null;
  language: string | null;
  created_at: string | null;
  duration: number | null;
  is_over_cap: boolean;
}

function newEntry(id: string, src: Partial<ExtraConversation>): Entry {
  return {
    id,
    label: (src.participant_name ?? "").trim() || null,
    is_finished: Boolean(src.is_finished),
    last_chunk_at: null,
    last_chunk_dt: null,
    has_error: false,
    error_message: null,
    latest_transcript: null,
    language: null,
    created_at: src.created_at ?? null,
    duration: src.duration ?? null,
    is_over_cap: Boolean(src.is_over_cap),
  };
}

/** _build_monitor_payload. `recentChunks` must be newest first. */
export function buildMonitorPayload(a: {
  recentChunks: readonly ChunkRow[];
  chunkCounts: ReadonlyMap<string, number>;
  transcribedCounts: ReadonlyMap<string, number>;
  now: Date;
  liveWindowSeconds: number;
  telemetry?: ReadonlyMap<string, Tele>;
  tagMap?: ReadonlyMap<string, string[]>;
  tagIdMap?: ReadonlyMap<string, string[]>;
  extraConversations?: readonly ExtraConversation[];
  tier?: string | null;
  overCapActive?: boolean;
  visitorStages?: ReadonlyMap<string, unknown>;
}) {
  const now = a.now.getTime();
  const order: string[] = [];
  const byConv = new Map<string, Entry>();
  for (const extra of a.extraConversations ?? []) {
    if (!extra.id || byConv.has(extra.id)) continue;
    byConv.set(extra.id, newEntry(extra.id, extra));
    order.push(extra.id);
  }
  for (const chunk of a.recentChunks) {
    const id = chunk.conversation_id;
    if (!id) continue;
    let entry = byConv.get(id);
    if (!entry) {
      entry = newEntry(id, { ...chunk, id });
      byConv.set(id, entry);
      order.push(id);
    }
    const dt = parseTs(chunk.timestamp);
    if (dt && (!entry.last_chunk_dt || dt > entry.last_chunk_dt)) {
      entry.last_chunk_dt = dt;
      entry.last_chunk_at = chunk.timestamp;
    }
    if (
      entry.latest_transcript === null &&
      typeof chunk.transcript === "string" &&
      chunk.transcript.trim()
    )
      entry.latest_transcript = clip(chunk.transcript, MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN);
    if (entry.language === null) {
      const language = chunk.desired_language || chunk.detected_language;
      if (typeof language === "string" && language.trim()) entry.language = language.trim();
    }
    if (typeof chunk.error === "string" && chunk.error.trim()) {
      entry.has_error = true;
      if (entry.error_message === null)
        entry.error_message = clip(chunk.error, MONITOR_ERROR_MESSAGE_MAX_LEN);
    }
  }

  const conversations: (Record<string, unknown> & { _sort: string; is_live: boolean })[] = [];
  let live = 0;
  let errors = 0;
  let finished = 0;
  let transcribing = 0;
  let stalled = 0;
  let offline = 0;
  let pendingTotal = 0;
  for (const id of order) {
    const e = byConv.get(id) as Entry;
    const tele = a.telemetry?.get(id);
    const reportedState = tele?.state;
    const seen = tele?.seen instanceof Date ? tele.seen : null;
    const lastChunk = e.last_chunk_dt;
    const pingFresh =
      seen !== null && seen.getTime() > now - MONITOR_HEARTBEAT_GRACE_SECONDS * 1000;
    const chunkWindow =
      seen !== null ? MONITOR_HEARTBEAT_GRACE_SECONDS : MONITOR_CONTACT_CHUNK_SECONDS;
    const chunkInContact = lastChunk !== null && lastChunk.getTime() > now - chunkWindow * 1000;
    const contactFresh = pingFresh || chunkInContact;
    const audioFresh =
      lastChunk !== null && lastChunk.getTime() > now - MONITOR_RECORDING_STALL_SECONDS * 1000;
    const chunkCount = a.chunkCounts.get(id) ?? 0;
    const transcribed = Math.min(a.transcribedCounts.get(id) ?? 0, chunkCount);
    const pending = Math.max(0, chunkCount - transcribed);
    const tStatus = transcriptionStatus(e.has_error, chunkCount, transcribed);
    const [state, health] = monitorStatus({
      isFinished: e.is_finished,
      reportedState,
      pingFresh,
      contactFresh,
      audioFresh,
      chunkCount,
      segmentSeconds: tele?.segment_seconds,
    });
    const isLive = contactFresh && !e.is_finished && health !== "left";
    let activity = lastChunk;
    if (seen && (!activity || seen > activity)) activity = seen;
    if (isLive) live++;
    if (e.is_finished) finished++;
    if (e.has_error) errors++;
    if (health === "stalled") stalled++;
    if (health === "offline") offline++;
    if (tStatus === "transcribing") transcribing++;
    pendingTotal += pending;
    const locked = conversationLocked(e, a.tier ?? null, a.overCapActive ?? false);
    conversations.push({
      id,
      label: e.label,
      is_live: isLive,
      is_finished: e.is_finished,
      locked,
      state,
      recording_health: health,
      audio_level: tele?.audio_level ?? null,
      mode: tele?.mode ?? null,
      tags: a.tagMap?.get(id) ?? [],
      tag_ids: a.tagIdMap?.get(id) ?? [],
      language: e.language,
      latest_transcript: locked ? null : e.latest_transcript,
      created_at: e.created_at,
      duration: e.duration,
      recorded_seconds: tele?.recorded_seconds ?? null,
      timeline: timeline(
        a.visitorStages?.get(id) ?? {},
        e.created_at,
        tele?.recording_started_at,
        e.last_chunk_at,
      ),
      network: tele?.network ?? null,
      battery: tele?.battery ?? null,
      last_chunk_at: e.last_chunk_at,
      last_seen_at: seen ? pyIsoformat(seen) : null,
      chunk_count: chunkCount,
      transcribed_count: transcribed,
      pending_transcription: pending,
      transcription_status: tStatus,
      has_error: e.has_error,
      error_message: e.error_message,
      _sort: activity ? pyIsoformat(activity) : "",
    });
  }
  // Two stable sorts: most recent activity first, then live conversations on top.
  conversations.sort((x, y) => (x._sort < y._sort ? 1 : x._sort > y._sort ? -1 : 0));
  conversations.sort((x, y) => Number(!x.is_live) - Number(!y.is_live));
  return {
    conversations: conversations.map(({ _sort, ...rest }) => rest),
    summary: {
      live,
      finished,
      transcribing,
      with_errors: errors,
      not_receiving: stalled,
      offline,
      total: conversations.length,
      pending_transcription: pendingTotal,
      catch_up_eta_seconds: pendingTotal * MONITOR_TRANSCRIBE_SECONDS_PER_CLIP,
    },
    live_window_seconds: a.liveWindowSeconds,
  };
}

/** _build_funnel: visitors not yet recording, newest first, counted per stage. */
export function buildFunnel(visitors: ReadonlyMap<string, Tele>, graduated: ReadonlySet<string>) {
  const counts: Record<string, number> = { scanned: 0, terms: 0, profile: 0 };
  const entries: (Record<string, unknown> & { _sort: string })[] = [];
  for (const [id, tele] of visitors) {
    if (graduated.has(id)) continue;
    let stage = tele.stage as string | undefined;
    if (stage && RETIRED_MIC_STAGES.has(stage)) stage = "terms";
    if (!stage || !VALID_VISITOR_STAGES.has(stage)) stage = "scanned";
    const seen = tele.seen instanceof Date ? pyIsoformat(tele.seen) : null;
    entries.push({
      id,
      stage,
      name: (typeof tele.name === "string" ? tele.name : "").trim() || null,
      tags: tele.tags || [],
      tags_preselected: Boolean(tele.tags_preselected),
      scan_count: Math.trunc(Number(tele.scan_count || 1)),
      device: tele.device ?? null,
      network: tele.network ?? null,
      battery: tele.battery ?? null,
      stages:
        tele.stages && typeof tele.stages === "object" && !Array.isArray(tele.stages)
          ? tele.stages
          : {},
      last_seen_at: seen,
      _sort: seen ?? "",
    });
    counts[stage] = (counts[stage] ?? 0) + 1;
  }
  entries.sort((x, y) => (x._sort < y._sort ? 1 : x._sort > y._sort ? -1 : 0));
  return {
    visitors: entries.map(({ _sort, ...rest }) => rest),
    summary: { ...counts, total: entries.length },
  };
}

/** The payload shape with zero activity, served while the monitor is switched off. */
export function emptyMonitorPayload(windowSeconds: number) {
  return {
    ...buildMonitorPayload({
      recentChunks: [],
      chunkCounts: new Map(),
      transcribedCounts: new Map(),
      now: new Date(),
      liveWindowSeconds: windowSeconds,
    }),
    funnel: buildFunnel(new Map(), new Set()),
  };
}

export type MonitorPayload = ReturnType<typeof emptyMonitorPayload>;

const ts = (v: unknown) => (v === null || v === undefined ? null : isoTimestamp(String(v)));

/**
 * gather_project_monitor: the reads behind the payload. Callers enforce access first.
 * The Python served these from a 3 second shared Redis snapshot; MonitorSnapshots below
 * keeps the same bound per process.
 */
export async function gatherProjectMonitor(
  db: Db,
  presence: Presence,
  logger: Logger,
  projectId: string,
  windowSeconds: number,
  gate: { tier: string | null; overCapActive: boolean },
  nowDate: Date,
): Promise<MonitorPayload> {
  const sql = (db as unknown as { $client: postgres.Sql }).$client;
  const since = new Date(nowDate.getTime() - MONITOR_LOOKBACK_SECONDS * 1000);
  const chunkRows = await sql<Record<string, unknown>[]>`
    select ch.conversation_id, c.participant_name, c.is_finished, c.created_at, c.duration,
           c.is_over_cap, ch.timestamp, ch.error, ch.transcript, ch.detected_language,
           ch.desired_language
    from conversation_chunk ch
    join conversation c on c.id = ch.conversation_id
    where c.project_id = ${projectId} and c.deleted_at is null
      and ch.source not in ${sql(PORTAL_ONLY)} and ch.timestamp > ${since.toISOString()}
    order by ch.timestamp desc
    limit ${MONITOR_MAX_CHUNKS}`;
  const recentChunks: ChunkRow[] = chunkRows.map((r) => ({
    conversation_id: String(r.conversation_id),
    participant_name: (r.participant_name as string | null) ?? null,
    is_finished: (r.is_finished as boolean | null) ?? null,
    created_at: ts(r.created_at),
    duration: (r.duration as number | null) ?? null,
    is_over_cap: (r.is_over_cap as boolean | null) ?? null,
    timestamp: ts(r.timestamp),
    error: (r.error as string | null) ?? null,
    transcript: (r.transcript as string | null) ?? null,
    detected_language: (r.detected_language as string | null) ?? null,
    desired_language: (r.desired_language as string | null) ?? null,
  }));
  const convIds: string[] = [];
  const seen = new Set<string>();
  for (const c of recentChunks)
    if (!seen.has(c.conversation_id)) {
      seen.add(c.conversation_id);
      convIds.push(c.conversation_id);
    }

  // Sessions pinging before their first chunk live in the active index, not the chunk read.
  // A ping names its project in the body, so the index is only a hint: a row counts only
  // when the conversation really belongs to this project (spec M-3: a foreign conversation
  // pinged under this project id showed its participant name here).
  let extra: ExtraConversation[] = [];
  try {
    const pingOnly = (await presence.activeConversationIds(projectId, since, nowDate)).filter(
      (id) => id && !seen.has(id) && /^[0-9a-f-]{36}$/i.test(id),
    );
    if (pingOnly.length) {
      const rows = await sql<Record<string, unknown>[]>`
        select id, participant_name, is_finished, created_at, duration, is_over_cap
        from conversation
        where id = any(${pingOnly}) and project_id = ${projectId} and deleted_at is null
        order by id`;
      extra = rows.map((r) => ({
        id: String(r.id),
        participant_name: (r.participant_name as string | null) ?? null,
        is_finished: (r.is_finished as boolean | null) ?? null,
        created_at: ts(r.created_at),
        duration: (r.duration as number | null) ?? null,
        is_over_cap: (r.is_over_cap as boolean | null) ?? null,
      }));
      for (const r of extra)
        if (!seen.has(r.id)) {
          seen.add(r.id);
          convIds.push(r.id);
        }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "monitor active-index read failed");
  }

  const chunkCounts = new Map<string, number>();
  const transcribedCounts = new Map<string, number>();
  const tagMap = new Map<string, string[]>();
  const tagIdMap = new Map<string, string[]>();
  if (convIds.length) {
    const counts = await sql<{ conversation_id: string; n: number; t: number }[]>`
      select conversation_id, count(*)::int as n,
             count(*) filter (where transcript is not null and transcript <> '')::int as t
      from conversation_chunk
      where conversation_id = any(${convIds}) and source not in ${sql(PORTAL_ONLY)}
      group by conversation_id`;
    for (const r of counts) {
      chunkCounts.set(String(r.conversation_id), r.n);
      if (r.t) transcribedCounts.set(String(r.conversation_id), r.t);
    }
    const tags = await sql<{ conversation_id: string; id: string | null; text: string | null }[]>`
      select cpt.conversation_id, pt.id, pt.text
      from conversation_project_tag cpt
      left join project_tag pt on pt.id = cpt.project_tag_id
      where cpt.conversation_id = any(${convIds})
      order by cpt.id
      limit 2000`;
    for (const r of tags) {
      if (!r.conversation_id || r.id === null) continue;
      const cid = String(r.conversation_id);
      if (typeof r.text === "string" && r.text.trim())
        tagMap.set(cid, [...(tagMap.get(cid) ?? []), r.text.trim()]);
      tagIdMap.set(cid, [...(tagIdMap.get(cid) ?? []), String(r.id)]);
    }
  }

  let telemetry = new Map<string, Tele>();
  try {
    telemetry = await presence.telemetryMany(convIds, nowDate);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "monitor liveness read failed");
  }
  const convVisitor = new Map<string, string>();
  for (const [cid, tele] of telemetry)
    if (tele.visitor_id) convVisitor.set(cid, String(tele.visitor_id));
  const visitorStages = new Map<string, unknown>();
  if (convVisitor.size) {
    try {
      const linked = await presence.visitorsMany(
        projectId,
        [...new Set(convVisitor.values())],
        nowDate,
      );
      for (const [cid, vid] of convVisitor) {
        const stages = linked.get(vid)?.stages;
        if (stages && typeof stages === "object" && !Array.isArray(stages))
          visitorStages.set(cid, stages);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "monitor visitor-stage join failed");
    }
  }

  const payload = buildMonitorPayload({
    recentChunks,
    chunkCounts,
    transcribedCounts,
    now: nowDate,
    liveWindowSeconds: windowSeconds,
    telemetry,
    tagMap,
    tagIdMap,
    extraConversations: extra,
    tier: gate.tier,
    overCapActive: gate.overCapActive,
    visitorStages,
  });

  const graduated = new Set(
    [...telemetry.values()].filter((t) => t.visitor_id).map((t) => String(t.visitor_id)),
  );
  let visitors = new Map<string, Tele>();
  try {
    const ids = await presence.activeVisitorIds(projectId, since, nowDate);
    if (ids.length) {
      visitors = await presence.visitorsMany(projectId, ids, nowDate);
      for (const v of await presence.linkedVisitorIds([...visitors.keys()], nowDate))
        graduated.add(v);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "monitor funnel read failed");
  }
  return { ...payload, funnel: buildFunnel(visitors, graduated) };
}

/**
 * workspace_over_cap_active: whether a free workspace is past its lifetime hour cap now.
 * Counts every conversation, deleted ones included, since delete keeps billable hours; a
 * sample copy's invented ones are no one's audio and are left out.
 */
export async function workspaceOverCapActive(
  db: Db,
  workspaceId: string | null,
  tier: string | null,
): Promise<boolean> {
  if (!workspaceId || tier === null || OVERAGE_TIERS.has(tier)) return false;
  const included = INCLUDED_HOURS[tier];
  if (included === undefined || included === null) return false;
  const sql = (db as unknown as { $client: postgres.Sql }).$client;
  const [row] = await sql<{ s: number | null }[]>`
    select coalesce(sum(c.duration), 0)::float8 as s
    from conversation c join project p on p.id = c.project_id
    where p.workspace_id = ${workspaceId} and not p.is_sample`;
  return (row?.s ?? 0) / 3600 >= included;
}

/** One computation per project and window every 3 seconds, however many hosts watch. */
export class MonitorSnapshots {
  private readonly cache = new Map<string, { at: number; value: Promise<MonitorPayload> }>();

  constructor(private readonly ttlMs = 3000) {}

  get(key: string, compute: () => Promise<MonitorPayload>): Promise<MonitorPayload> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > 500)
      for (const [k, v] of this.cache) if (Date.now() - v.at >= this.ttlMs) this.cache.delete(k);
    return value;
  }
}
