import type { Signed } from "@dembrane/http";
import { agentProject } from "../access";
import { type DataDeps, isUuid, type Row, row, sqlOf, text } from "./deps";
import { conversationLocked, workspaceOverCapActive } from "./locks";

// Live monitor tuning, the host monitor's values: a conversation is shown when a chunk
// landed in the lookback; the chunk read is capped so a busy project stays cheap.
const LOOKBACK_SECONDS = 1800;
const MAX_CHUNKS = 500;
const ERROR_MAX = 240;
const TRANSCRIPT_MAX = 280;
// A recent chunk counts as contact; clients that ping have a shorter grace, but the
// platform has no ping store yet, so every conversation is judged on chunks alone.
const CONTACT_CHUNK_SECONDS = 60;
const RECORDING_STALL_SECONDS = 45;
const TRANSCRIBE_SECONDS_PER_CLIP = 20;
const EXCLUDED_SOURCES = ["DASHBOARD_UPLOAD", "CLONE"];

interface Entry {
  id: string;
  label: string | null;
  is_finished: boolean;
  last_chunk_at: string | null;
  last_chunk_ms: number | null;
  has_error: boolean;
  error_message: string | null;
  latest_transcript: string | null;
  language: string | null;
  created_at: string | null;
  duration: unknown;
  is_over_cap: boolean;
}

/** (state, recording_health) from chunk arrival alone: the no-ping branch of the host monitor. */
function monitorStatus(e: Entry, contactFresh: boolean, audioFresh: boolean, chunkCount: number) {
  if (e.is_finished) return ["finished", "finished"] as const;
  if (!contactFresh) {
    if (chunkCount > 0) return ["offline", "offline"] as const;
    return ["initiated", "waiting"] as const;
  }
  const state = audioFresh ? "recording" : chunkCount > 0 ? "idle" : "initiated";
  const health = audioFresh ? "receiving" : chunkCount > 0 ? "idle" : "waiting";
  return [state, health] as const;
}

function transcriptionStatus(hasError: boolean, chunks: number, transcribed: number) {
  if (chunks <= 0) return "idle";
  if (hasError) return "failing";
  return chunks - transcribed > 0 ? "transcribing" : "up_to_date";
}

/**
 * GET /agentic/projects/{p}/monitor: which portal conversations are recording now, their
 * transcription progress and failures, the same shape as the host monitor. Participant
 * pings and the pre-conversation funnel lived in Redis and have no store here yet, so
 * liveness comes from chunk arrival (the host monitor's own fallback when Redis is
 * unreachable) and the funnel is empty.
 */
export async function monitor(d: DataDeps, who: Signed, projectId: string, windowSeconds: number) {
  const access = await agentProject(d.access, who, projectId);
  const sql = sqlOf(d);
  const now = d.now();
  const cutoff = new Date(now.getTime() - LOOKBACK_SECONDS * 1000).toISOString();
  const chunks = isUuid(projectId)
    ? await sql`
        select ch.timestamp, ch.error, ch.transcript, ch.detected_language, ch.desired_language,
               c.id, c.participant_name, c.is_finished, c.created_at, c.duration, c.is_over_cap
        from conversation_chunk ch join conversation c on c.id = ch.conversation_id
        where c.project_id = ${projectId} and c.deleted_at is null
          and (ch.source is null or ch.source <> all(${EXCLUDED_SOURCES}))
          and ch.timestamp > ${cutoff}
        order by ch.timestamp desc
        limit ${MAX_CHUNKS}`
    : [];

  const order: string[] = [];
  const byConv = new Map<string, Entry>();
  for (const raw of chunks) {
    const c = row(raw as Row);
    const id = String(c.id);
    let e = byConv.get(id);
    if (!e) {
      e = {
        id,
        label: text(c.participant_name),
        is_finished: Boolean(c.is_finished),
        last_chunk_at: null,
        last_chunk_ms: null,
        has_error: false,
        error_message: null,
        latest_transcript: null,
        language: null,
        created_at: (c.created_at as string | null) ?? null,
        duration: c.duration ?? null,
        is_over_cap: Boolean(c.is_over_cap),
      };
      byConv.set(id, e);
      order.push(id);
    }
    const ts = typeof c.timestamp === "string" ? c.timestamp : null;
    const ms = ts ? Date.parse(ts) : Number.NaN;
    if (!Number.isNaN(ms) && (e.last_chunk_ms === null || ms > e.last_chunk_ms)) {
      e.last_chunk_ms = ms;
      e.last_chunk_at = ts;
    }
    if (e.latest_transcript === null && typeof c.transcript === "string" && c.transcript.trim())
      e.latest_transcript = c.transcript.trim().slice(0, TRANSCRIPT_MAX);
    if (e.language === null) {
      const lang = c.desired_language || c.detected_language;
      if (typeof lang === "string" && lang.trim()) e.language = lang.trim();
    }
    if (typeof c.error === "string" && c.error.trim()) {
      e.has_error = true;
      if (e.error_message === null) e.error_message = c.error.trim().slice(0, ERROR_MAX);
    }
  }

  const counts = new Map<string, number>();
  const transcribed = new Map<string, number>();
  const tags = new Map<string, string[]>();
  const tagIds = new Map<string, string[]>();
  if (order.length) {
    const agg = await sql`
      select conversation_id, count(*)::int as n,
             count(*) filter (where transcript is not null and transcript <> '')::int as t
      from conversation_chunk
      where conversation_id = any(${order})
        and (source is null or source <> all(${EXCLUDED_SOURCES}))
      group by conversation_id`;
    for (const r of agg) {
      counts.set(String(r.conversation_id), Number(r.n));
      transcribed.set(String(r.conversation_id), Number(r.t));
    }
    const tagRows = await sql`
      select cpt.conversation_id, pt.id, pt.text from conversation_project_tag cpt
      join project_tag pt on pt.id = cpt.project_tag_id
      where cpt.conversation_id = any(${order}) order by cpt.id limit 2000`;
    for (const r of tagRows) {
      const cid = String(r.conversation_id);
      if (typeof r.text === "string" && r.text.trim())
        tags.set(cid, [...(tags.get(cid) ?? []), r.text.trim()]);
      tagIds.set(cid, [...(tagIds.get(cid) ?? []), String(r.id)]);
    }
  }

  const tier = access
    ? access.tier
    : ((
        await sql`
          select b.tier from project p join workspace w on w.id = p.workspace_id
          join billing_account b on b.id = w.billing_account_id where p.id = ${projectId}`
      )[0]?.tier ?? null);
  const workspaceId = access
    ? access.project.workspaceId
    : text(
        (
          await sql`select workspace_id from project where id = ${isUuid(projectId) ? projectId : null}`
        )[0]?.workspace_id,
      );
  const overCap = workspaceId ? await workspaceOverCapActive(d, workspaceId, tier) : false;

  const nowMs = now.getTime();
  let live = 0;
  let finished = 0;
  let errors = 0;
  let transcribing = 0;
  let offline = 0;
  let pendingTotal = 0;
  const out = order.map((id) => {
    const e = byConv.get(id) as Entry;
    const contact =
      e.last_chunk_ms !== null && e.last_chunk_ms > nowMs - CONTACT_CHUNK_SECONDS * 1000;
    const audio =
      e.last_chunk_ms !== null && e.last_chunk_ms > nowMs - RECORDING_STALL_SECONDS * 1000;
    const chunkCount = counts.get(id) ?? 0;
    const transcribedCount = Math.min(transcribed.get(id) ?? 0, chunkCount);
    const pending = Math.max(0, chunkCount - transcribedCount);
    const tStatus = transcriptionStatus(e.has_error, chunkCount, transcribedCount);
    const [state, health] = monitorStatus(e, contact, audio, chunkCount);
    const isLive = contact && !e.is_finished;
    if (isLive) live++;
    if (e.is_finished) finished++;
    if (e.has_error) errors++;
    if (health === "offline") offline++;
    if (tStatus === "transcribing") transcribing++;
    pendingTotal += pending;
    const locked = conversationLocked(e, tier, overCap);
    const timeline: { key: string; at: string }[] = [];
    if (e.created_at) timeline.push({ key: "created", at: e.created_at });
    if (e.last_chunk_at) timeline.push({ key: "last_audio", at: e.last_chunk_at });
    return {
      id,
      label: e.label,
      is_live: isLive,
      is_finished: e.is_finished,
      locked,
      state,
      recording_health: health,
      audio_level: null,
      mode: null,
      tags: tags.get(id) ?? [],
      tag_ids: tagIds.get(id) ?? [],
      language: e.language,
      latest_transcript: locked ? null : e.latest_transcript,
      created_at: e.created_at,
      duration: e.duration,
      recorded_seconds: null,
      timeline,
      network: null,
      battery: null,
      last_chunk_at: e.last_chunk_at,
      last_seen_at: null,
      chunk_count: chunkCount,
      transcribed_count: transcribedCount,
      pending_transcription: pending,
      transcription_status: tStatus,
      has_error: e.has_error,
      error_message: e.error_message,
      _sort: e.last_chunk_ms ?? -1,
    };
  });
  out.sort((a, b) => b._sort - a._sort);
  out.sort((a, b) => Number(!a.is_live) - Number(!b.is_live));
  return {
    conversations: out.map(({ _sort, ...rest }) => rest),
    summary: {
      live,
      finished,
      transcribing,
      with_errors: errors,
      not_receiving: 0,
      offline,
      total: out.length,
      pending_transcription: pendingTotal,
      catch_up_eta_seconds: pendingTotal * TRANSCRIBE_SECONDS_PER_CLIP,
    },
    live_window_seconds: windowSeconds,
    funnel: {
      visitors: [],
      summary: { scanned: 0, terms: 0, profile: 0, total: 0 },
    },
  };
}
