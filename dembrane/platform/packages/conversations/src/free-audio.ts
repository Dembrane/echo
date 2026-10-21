import {
  type AllowanceAccount,
  add,
  allowanceForProject,
  type FreeLimits,
  freeLimitError,
  freeLimits,
  isFreeLimit,
  recordingProject,
  take,
  usedThisPeriod,
  withAllowanceLock,
} from "@dembrane/allowance";
import { AudioError, fileFormatOf, type Measured, measureSeconds } from "@dembrane/audio";
import { BadRequestError, StatusError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
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
// Confirm measures inside the request, under the API's 255 s idle timeout.
export const UPLOAD_MEASURE_TIMEOUT_MS = 120_000;
// A live chunk is about 30 s; past this it fails open like any measuring failure.
export const LIVE_MEASURE_TIMEOUT_MS = 15_000;

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AudioError("transient", `measuring timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function measureUpload(d: ConversationsDeps, key: string, bytes: number, live = false) {
  const t = d.settings.measureTimeoutMs;
  const ms = live ? (t?.live ?? LIVE_MEASURE_TIMEOUT_MS) : (t?.upload ?? UPLOAD_MEASURE_TIMEOUT_MS);
  try {
    const source = {
      url: d.audio.presignDownload(key, { expiresInSeconds: MEASURE_URL_EXPIRES_S }),
      format: fileFormatOf(key),
      name: key,
    };
    return await deadline(measureSeconds(d.media, source, bytes), ms);
  } catch (err) {
    if (err instanceof AudioError && err.terminal)
      return { unreadable: true, reason: err.message } satisfies Measured;
    throw err;
  }
}

// Anything that stops the measurement is a retry: nothing reserved, the object kept.
async function measureFailed<T>(d: ConversationsDeps, conversationId: string, f: () => Promise<T>) {
  try {
    return await f();
  } catch (err) {
    d.logger.error(
      { err, conversationId, signal: "free_audio.measure_failed" },
      "measuring an upload failed",
    );
    throw new StatusError(503, "upload.measure_failed");
  }
}

/** What confirm counted for a free chunk. */
export interface CountedChunk {
  readonly audioSeconds: number | null;
  readonly error: string | null;
}
/** The issued chunk id, and how to write it inside the caller's locked transaction. */
export interface ChunkWrite {
  readonly id: string;
  readonly insert: (tx: Db, row: CountedChunk) => Promise<ChunkRow>;
}

// A confirm retried while the first one ran: the chunk it already wrote.
async function written(tx: Db, conversationId: string, id: string): Promise<ChunkRow | null> {
  const row = await conversationStore(tx).chunk(id);
  return row?.conversation_id === conversationId ? { ...row, pending_text: null } : null;
}

// Never deletes an object a chunk row points at.
async function drop(d: ConversationsDeps, conversationId: string, key: string, chunkId: string) {
  const c = schema.conversation_chunk;
  try {
    const held = await d.db
      .select({ id: c.id })
      .from(c)
      .where(or(eq(c.id, chunkId), eq(c.path, d.audioUrls.fileUrl(key))))
      .limit(1);
    if (held.length) return;
    await d.audio.delete(key);
  } catch (err) {
    d.logger.error({ err, key, conversationId }, "deleting a refused upload failed");
  }
}

/**
 * Measures an upload and, under the account lock, reserves its seconds and writes its chunk.
 * Null for unlimited; a refused file is deleted from the bucket.
 */
export async function reserveUpload(
  d: ConversationsDeps,
  conv: { id: string; project_id: string },
  key: string,
  bytes: number,
  write: ChunkWrite,
): Promise<ChunkRow | null> {
  const pre = await measureFailed(d, conv.id, async () => {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    const limits = await freeLimits(d.db, d.now, d.logger);
    return { a, limits, home: await recordingProject(d.db, a) };
  });
  if (!pre) return null;
  const { a, limits } = pre;
  const fileLimit = limits.audio_seconds_conversation;
  const monthLimit = limits.audio_seconds_month;
  const refuse = async (err: Error): Promise<never> => {
    await drop(d, conv.id, key, write.id);
    throw err;
  };
  // Also for a conversation that already has audio: only the recording project takes files.
  if (pre.home !== conv.project_id) return refuse(freeLimitError("recording_project"));
  const measured = await measureFailed(d, conv.id, () => measureUpload(d, key, bytes));
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
  try {
    return await withAllowanceLock(d.db, a, async (tx) => {
      const prior = await written(tx, conv.id, write.id);
      if (prior) return prior;
      const t = await take(tx, a, "audio_seconds", reserved, monthLimit);
      if (!t.ok)
        throw freeLimitError("audio_month", {
          file_seconds: reserved,
          remaining_seconds: Math.max(0, t.limit - t.used),
        });
      // The file joins whatever the conversation already holds.
      if (
        (await conversationSeconds(tx, conv.id)) + measured.seconds >
        fileLimit + FILE_TOLERANCE_S
      )
        throw freeLimitError("audio_conversation", {
          file_seconds: reserved,
          limit_seconds: fileLimit,
        });
      return write.insert(tx, { audioSeconds: measured.seconds, error: null });
    });
  } catch (err) {
    if (isFreeLimit(err)) return refuse(err as Error);
    throw err;
  }
}

// The recorder cuts at 30 s (60 s at most); a longer "live" chunk is counted as an upload.
export const LIVE_CHUNK_MAX_SECONDS = 90;

// Metered seconds; a live chunk confirm could not measure counts 0 until the pipeline meters it.
export async function conversationSeconds(db: Db, conversationId: string): Promise<number> {
  const { conversation_chunk } = schema;
  const [row] = await db
    .select({ s: sql<string>`coalesce(sum(${conversation_chunk.audio_seconds}), 0)` })
    .from(conversation_chunk)
    .where(eq(conversation_chunk.conversation_id, conversationId));
  return Number(row?.s ?? 0);
}

// The recorder's 30 s chunk is under this at any speech bitrate; larger never passes unmeasured.
export const LIVE_CHUNK_BYTES = 1024 * 1024;

interface LiveVerdict {
  readonly refuse: AudioRefusal | null;
  readonly stop: AudioRefusal | null;
  readonly conv: number;
}

async function liveVerdict(
  db: Db,
  a: AllowanceAccount,
  limits: FreeLimits,
  conversationId: string,
): Promise<LiveVerdict> {
  const conv = await conversationSeconds(db, conversationId);
  const used = (await usedThisPeriod(db, a)).audio_seconds;
  const convLimit = limits.audio_seconds_conversation;
  const monthLimit = limits.audio_seconds_month;
  const v = (refuse: AudioRefusal | null, stop: AudioRefusal | null) => ({ refuse, stop, conv });
  if (conv >= convLimit + LIVE_GRACE_SECONDS) return v("audio_conversation", null);
  if (used >= monthLimit + LIVE_GRACE_SECONDS) return v("audio_month", null);
  if (conv >= convLimit) return v(null, "audio_conversation");
  if (used >= monthLimit) return v(null, "audio_month");
  return v(null, null);
}

/**
 * A live chunk's verdict: throws past the grace, returns the stop signal at the limit.
 * Fails open: any error reading the limits accepts the chunk.
 */
export async function liveChunkCheck(
  d: Pick<ConversationsDeps, "db" | "now" | "logger">,
  conv: { id: string; project_id: string },
  opts: { home?: boolean } = {},
): Promise<AudioRefusal | null> {
  let v: LiveVerdict;
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    // A started recording with no audio yet still belongs to the recording project.
    if (opts.home && (await recordingProject(d.db, a)) !== conv.project_id)
      v = { refuse: "recording_project", stop: null, conv: 0 };
    else v = await liveVerdict(d.db, a, await freeLimits(d.db, d.now, d.logger), conv.id);
  } catch (err) {
    d.logger.error(
      { err, conversationId: conv.id, signal: "free_audio.live_check_failed" },
      "live chunk limit check failed",
    );
    return null;
  }
  if (v.refuse) throw freeLimitError(v.refuse);
  return v.stop;
}

/**
 * A free account's live chunk: measured, then checked and counted under the account
 * lock in the transaction that writes it, so confirms cannot outrun the limits. A failing
 * check or measurement keeps the chunk unmetered for the pipeline (rule 3).
 */
export async function confirmLiveChunk(
  d: ConversationsDeps,
  a: AllowanceAccount,
  conv: { id: string; project_id: string },
  key: string,
  bytes: number,
  write: ChunkWrite,
): Promise<{ chunk: ChunkRow; recordingStop: AudioRefusal | null }> {
  const failed = (signal: string) => (err: unknown) => {
    d.logger.error({ err, conversationId: conv.id, signal }, "live chunk check failed");
    return null;
  };
  try {
    const measured = await measureUpload(d, key, bytes, true).catch(
      failed("free_audio.live_measure_failed"),
    );
    const s = measured && "seconds" in measured ? measured.seconds : null;
    const limits = await freeLimits(d.db, d.now, d.logger).catch(
      failed("free_audio.live_check_failed"),
    );
    return await withAllowanceLock(d.db, a, async (tx) => {
      const prior = await written(tx, conv.id, write.id);
      const v = limits
        ? await tx
            .transaction((sp) => liveVerdict(sp as unknown as Db, a, limits, conv.id))
            .catch(failed("free_audio.live_check_failed"))
        : null;
      if (prior) return { chunk: prior, recordingStop: v ? (v.refuse ?? v.stop) : null };
      if (v?.refuse) throw freeLimitError(v.refuse);
      let row: CountedChunk = { audioSeconds: null, error: null };
      if (v && limits && s !== null) {
        const seconds = Math.round(s);
        // add and take run in their own savepoint, so a ledger error leaves the insert usable.
        if (s <= LIVE_CHUNK_MAX_SECONDS) {
          const ok = await add(tx, a, "audio_seconds", seconds).then(
            () => true,
            failed("free_audio.meter_failed"),
          );
          if (ok) row = { ...row, audioSeconds: s };
        } else {
          // Too long for a live chunk: counted like an upload or kept out, never trimmed.
          const convLimit = limits.audio_seconds_conversation + FILE_TOLERANCE_S;
          const fits =
            v.conv + s <= convLimit &&
            (await take(tx, a, "audio_seconds", seconds, limits.audio_seconds_month).then(
              (t) => t.ok,
              failed("free_audio.meter_failed"),
            ));
          // A failed ledger read leaves it to the pipeline.
          if (fits !== null)
            row = fits ? { ...row, audioSeconds: s } : { ...row, error: FREE_LIMIT_SKIPPED };
        }
      }
      return { chunk: await write.insert(tx, row), recordingStop: v?.stop ?? null };
    });
  } catch (err) {
    if (isFreeLimit(err)) await drop(d, conv.id, key, write.id);
    throw err;
  }
}

/** The stop signal a live chunk would get now; never throws. */
export async function liveStopNow(
  d: Pick<ConversationsDeps, "db" | "now" | "logger">,
  conv: { id: string; project_id: string },
): Promise<AudioRefusal | null> {
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    const v = await liveVerdict(d.db, a, await freeLimits(d.db, d.now, d.logger), conv.id);
    return v.refuse ?? v.stop;
  } catch (err) {
    d.logger.error(
      { err, conversationId: conv.id, signal: "free_audio.live_check_failed" },
      "live chunk limit check failed",
    );
    return null;
  }
}

export type LiveMeter = "unlimited" | "counted" | "already" | "unmeasured" | "refused";

/**
 * Counts a live chunk's seconds once, in the month it landed in. Throws only for a chunk of
 * LIVE_CHUNK_BYTES or more, so the step retries.
 * Idempotent through the `audio_seconds is null` guard.
 */
export async function meterLiveChunk(
  d: PipelineDeps,
  chunk: ChunkRow,
  measure: () => Promise<number | null>,
  bytes: number,
): Promise<LiveMeter> {
  const { conversation_chunk } = schema;
  try {
    const conv = await conversationStore(d.db).conversation(chunk.conversation_id);
    if (!conv) return "unmeasured";
    const landed = chunk.created_at ? new Date(chunk.created_at) : d.now();
    const a = await allowanceForProject(d.db, conv.project_id, landed);
    if (!a) return "unlimited";
    if (chunk.audio_seconds !== null) return "already";
    if (chunk.error === FREE_LIMIT_SKIPPED) return "refused";
    const s = await measure();
    if (s === null || !Number.isFinite(s) || s < 0) {
      if (bytes >= LIVE_CHUNK_BYTES) throw new AudioError("value", "live chunk has no length");
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
        .where(
          and(
            eq(conversation_chunk.id, chunk.id),
            isNull(conversation_chunk.audio_seconds),
            sql`${conversation_chunk.error} is distinct from ${FREE_LIMIT_SKIPPED}`,
          ),
        )
        .returning({ id: conversation_chunk.id });
      if (claimed.length === 0) return "already";
      if (!limits) {
        await add(db, a, "audio_seconds", seconds);
        return "counted";
      }
      // Too long for a live chunk: refused like an upload, never trimmed.
      const convLimit = limits.audio_seconds_conversation + FILE_TOLERANCE_S;
      const fits =
        s <= convLimit &&
        (await conversationSeconds(db, chunk.conversation_id)) <= convLimit &&
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
    // Only a chunk the recorder could have made passes unmeasured; a larger one retries.
    if (bytes >= LIVE_CHUNK_BYTES) throw err;
    d.logger.error(
      { err, chunkId: chunk.id, signal: "free_audio.meter_failed" },
      "metering a live chunk failed",
    );
    return "unmeasured";
  }
}
