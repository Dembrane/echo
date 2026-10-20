import {
  type AllowanceAccount,
  add,
  allowanceForProject,
  type FreeLimits,
  freeLimitError,
  freeLimits,
  recordingProject,
  take,
  usedThisPeriod,
} from "@dembrane/allowance";
import { AudioError, fileFormatOf, type Measured, measureSeconds } from "@dembrane/audio";
import { BadRequestError, StatusError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { ConversationsDeps } from "./deps";
import type { PipelineDeps } from "./pipeline/steps";
import { type ChunkRow, conversationStore } from "./storage";

export const LIVE_SOURCE = "PORTAL_AUDIO";
// Past the limit by this much before a live chunk is refused: the portal stops itself first.
export const LIVE_GRACE_SECONDS = 120;
// Set on a chunk the free limit kept out of the transcript.
export const FREE_LIMIT_SKIPPED = "Over the free plan's recording limit";
export type AudioRefusal = "audio_month" | "audio_conversation" | "recording_project";

type AudioDeps = Pick<ConversationsDeps, "db" | "now"> & Partial<Pick<ConversationsDeps, "logger">>;

interface Verdict {
  readonly a: AllowanceAccount;
  readonly limits: FreeLimits;
  readonly refusal: AudioRefusal | null;
}

async function verdict(d: AudioDeps, projectId: string): Promise<Verdict | null> {
  const a = await allowanceForProject(d.db, projectId, d.now());
  if (!a) return null;
  const limits = await freeLimits(d.db, d.now, d.logger);
  if ((await recordingProject(d.db, a)) !== projectId)
    return { a, limits, refusal: "recording_project" };
  const used = await usedThisPeriod(d.db, a);
  if (used.audio_seconds >= limits.audio_seconds_month)
    return { a, limits, refusal: "audio_month" };
  return { a, limits, refusal: null };
}

// Null for unlimited; throws the limit error when this project may not start audio.
export async function requireAudioStart(
  d: AudioDeps,
  projectId: string,
): Promise<AllowanceAccount | null> {
  const v = await verdict(d, projectId);
  if (!v) return null;
  if (v.refusal === "recording_project") throw freeLimitError("recording_project");
  if (v.refusal === "audio_month") throw freeLimitError("audio_month", { remaining_seconds: 0 });
  return v.a;
}

// What the portal shows before starting; never throws.
export async function audioOpen(
  d: AudioDeps,
  projectId: string,
): Promise<{ open: boolean; conversationLimitSeconds: number | null }> {
  try {
    const v = await verdict(d, projectId);
    if (!v) return { open: true, conversationLimitSeconds: null };
    return {
      open: v.refusal === null,
      conversationLimitSeconds: v.limits.audio_seconds_conversation,
    };
  } catch (err) {
    d.logger?.error(
      { err, projectId, signal: "free_audio.open_check_failed" },
      "audio open check failed",
    );
    return { open: true, conversationLimitSeconds: null };
  }
}

export async function hasAudioChunk(db: Db, conversationId: string): Promise<boolean> {
  const { conversation_chunk } = schema;
  const rows = await db
    .select({ id: conversation_chunk.id })
    .from(conversation_chunk)
    .where(
      and(
        eq(conversation_chunk.conversation_id, conversationId),
        isNotNull(conversation_chunk.path),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const MEASURE_URL_EXPIRES_S = 600;
const FILE_TOLERANCE_S = 1;

async function measureUpload(
  d: ConversationsDeps,
  key: string,
  bytes: number,
  confirmAbove: number,
) {
  try {
    const source = {
      url: d.audio.presignDownload(key, { expiresInSeconds: MEASURE_URL_EXPIRES_S }),
      format: fileFormatOf(key),
      name: key,
    };
    return await measureSeconds(d.media, source, bytes, { confirmAbove });
  } catch (err) {
    if (err instanceof AudioError && err.terminal)
      return { unreadable: true, reason: err.message } satisfies Measured;
    if (err instanceof AudioError) throw new StatusError(503, "upload.measure_failed");
    throw err;
  }
}

/**
 * Measures an upload and reserves its seconds on a free account before any transcription.
 * Null for unlimited; a refused file is deleted from the bucket.
 */
export async function reserveUpload(
  d: ConversationsDeps,
  conv: { id: string; project_id: string },
  key: string,
  bytes: number,
): Promise<{ a: AllowanceAccount; seconds: number; reserved: number } | null> {
  const a = await allowanceForProject(d.db, conv.project_id, d.now());
  if (!a) return null;
  const limits = await freeLimits(d.db, d.now, d.logger);
  const fileLimit = limits.audio_seconds_conversation;
  const monthLimit = limits.audio_seconds_month;
  const measured = await measureUpload(d, key, bytes, fileLimit);
  const refuse = async (err: Error): Promise<never> => {
    await d.audio
      .delete(key)
      .catch((e) =>
        d.logger.error(
          { err: e, key, conversationId: conv.id },
          "deleting a refused upload failed",
        ),
      );
    throw err;
  };
  if ("unreadable" in measured) {
    d.logger.warn(
      { conversationId: conv.id, reason: measured.reason, signal: "free_audio.upload_unreadable" },
      "upload could not be read as audio",
    );
    return refuse(new BadRequestError("upload.unreadable"));
  }
  const reserved = Math.round(measured.seconds);
  // A second of tolerance: decoders overrun an exact-length file by a few ms.
  if (measured.seconds > fileLimit + FILE_TOLERANCE_S)
    return refuse(
      freeLimitError("audio_conversation", { file_seconds: reserved, limit_seconds: fileLimit }),
    );
  const t = await take(d.db, a, "audio_seconds", reserved, monthLimit);
  if (!t.ok)
    return refuse(
      freeLimitError("audio_month", {
        file_seconds: reserved,
        remaining_seconds: Math.max(0, t.limit - t.used),
      }),
    );
  return { a, seconds: measured.seconds, reserved };
}

// The recorder cuts at 30 s (60 s at most); a longer "live" chunk is counted as an upload.
export const LIVE_CHUNK_MAX_SECONDS = 90;

export async function conversationSeconds(db: Db, conversationId: string): Promise<number> {
  const { conversation_chunk } = schema;
  const [row] = await db
    .select({ s: sql<string>`coalesce(sum(${conversation_chunk.audio_seconds}), 0)` })
    .from(conversation_chunk)
    .where(eq(conversation_chunk.conversation_id, conversationId));
  return Number(row?.s ?? 0);
}

/**
 * A live chunk's verdict: throws past the grace, returns the stop signal at the limit.
 * Fails open: any error reading the limits accepts the chunk.
 */
export async function liveChunkCheck(
  d: Pick<ConversationsDeps, "db" | "now" | "logger">,
  conv: { id: string; project_id: string },
): Promise<AudioRefusal | null> {
  let state: { conv: number; convLimit: number; used: number; monthLimit: number };
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    const limits = await freeLimits(d.db, d.now, d.logger);
    state = {
      conv: await conversationSeconds(d.db, conv.id),
      convLimit: limits.audio_seconds_conversation,
      used: (await usedThisPeriod(d.db, a)).audio_seconds,
      monthLimit: limits.audio_seconds_month,
    };
  } catch (err) {
    d.logger.error(
      { err, conversationId: conv.id, signal: "free_audio.live_check_failed" },
      "live chunk limit check failed",
    );
    return null;
  }
  if (state.conv >= state.convLimit + LIVE_GRACE_SECONDS)
    throw freeLimitError("audio_conversation");
  if (state.used >= state.monthLimit + LIVE_GRACE_SECONDS) throw freeLimitError("audio_month");
  if (state.conv >= state.convLimit) return "audio_conversation";
  if (state.used >= state.monthLimit) return "audio_month";
  return null;
}

export type LiveMeter = "unlimited" | "counted" | "already" | "unmeasured" | "refused";

/**
 * Counts a live chunk's seconds once, in the month it landed in. Never throws.
 * Idempotent through the `audio_seconds is null` guard.
 */
export async function meterLiveChunk(
  d: PipelineDeps,
  chunk: ChunkRow,
  measure: () => Promise<number | null>,
): Promise<LiveMeter> {
  const { conversation_chunk } = schema;
  try {
    const conv = await conversationStore(d.db).conversation(chunk.conversation_id);
    if (!conv) return "unmeasured";
    const landed = chunk.created_at ? new Date(chunk.created_at) : d.now();
    const a = await allowanceForProject(d.db, conv.project_id, landed);
    if (!a) return "unlimited";
    if (chunk.audio_seconds !== null) return "already";
    const s = await measure();
    if (s === null || !Number.isFinite(s) || s < 0) {
      d.logger.warn(
        { chunkId: chunk.id, signal: "free_audio.meter_failed" },
        "live chunk has no length",
      );
      return "unmeasured";
    }
    const seconds = Math.round(s);
    const upload = s > LIVE_CHUNK_MAX_SECONDS;
    const limits = upload ? await freeLimits(d.db, d.now, d.logger) : null;
    return await d.db.transaction(async (tx): Promise<LiveMeter> => {
      const db = tx as unknown as Db;
      const claimed = await db
        .update(conversation_chunk)
        .set({ audio_seconds: s })
        .where(and(eq(conversation_chunk.id, chunk.id), isNull(conversation_chunk.audio_seconds)))
        .returning({ id: conversation_chunk.id });
      if (claimed.length === 0) return "already";
      if (!limits) {
        await add(db, a, "audio_seconds", seconds);
        return "counted";
      }
      // Too long for a live chunk: refused like an upload, never trimmed.
      const fits =
        s <= limits.audio_seconds_conversation + FILE_TOLERANCE_S &&
        (await take(db, a, "audio_seconds", seconds, limits.audio_seconds_month)).ok;
      if (fits) return "counted";
      await db
        .update(conversation_chunk)
        .set({ audio_seconds: null, error: FREE_LIMIT_SKIPPED, updated_at: d.now().toISOString() })
        .where(eq(conversation_chunk.id, chunk.id));
      d.logger.warn(
        { chunkId: chunk.id, seconds, signal: "free_audio.long_live_chunk_refused" },
        "long live chunk is over the free limit, skipped",
      );
      return "refused";
    });
  } catch (err) {
    d.logger.error(
      { err, chunkId: chunk.id, signal: "free_audio.meter_failed" },
      "metering a live chunk failed",
    );
    return "unmeasured";
  }
}
