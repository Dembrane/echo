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
import { BadRequestError, newId, StatusError } from "@dembrane/core";
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

async function measureUpload(d: ConversationsDeps, key: string, bytes: number) {
  try {
    const source = {
      url: d.audio.presignDownload(key, { expiresInSeconds: MEASURE_URL_EXPIRES_S }),
      format: fileFormatOf(key),
      name: key,
    };
    return await measureSeconds(d.media, source, bytes);
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

/** What confirm writes for a free chunk: the frozen copy and what it counted. */
export interface FrozenChunk {
  readonly key: string;
  readonly audioSeconds: number | null;
  readonly error: string | null;
}
/** Writes the chunk inside the caller's locked transaction. */
export type InsertChunk = (tx: Db, row: FrozenChunk) => Promise<ChunkRow>;

// A live chunk is small: a copy taking longer is a stuck bucket.
const LIVE_COPY_TIMEOUT_MS = 15_000;

// A presigned form stays writable for an hour: a free chunk is copied to a key no form names.
async function freeze(
  d: ConversationsDeps,
  conversationId: string,
  key: string,
  timeoutMs?: number,
) {
  const frozen = `conversation/${conversationId}/audio/${newId()}-${key.slice(key.lastIndexOf("/") + 1)}`;
  const opts = timeoutMs ? { timeoutMs } : {};
  try {
    await d.audio.copy(key, frozen, opts).catch(async (err) => {
      d.logger.warn(
        { err, conversationId, key, signal: "free_audio.freeze_retry" },
        "copy failed, retrying",
      );
      await d.audio.copy(key, frozen, opts);
    });
  } catch (err) {
    // A timed-out copy may still land; best effort against an orphan.
    await drop(d, conversationId, [frozen]);
    throw err;
  }
  return frozen;
}

/**
 * Freezes a live chunk. A recorder-sized chunk the bucket will not copy stays at its upload
 * key (rule 3); a larger one fails, since a big object is how a copy is made to time out.
 */
export async function freezeLive(
  d: ConversationsDeps,
  conversationId: string,
  key: string,
  bytes: number,
) {
  try {
    return await freeze(d, conversationId, key, LIVE_COPY_TIMEOUT_MS);
  } catch (err) {
    if (bytes >= LIVE_CHUNK_BYTES) throw err;
    d.logger.error(
      { err, conversationId, key, signal: "free_audio.freeze_failed" },
      "freezing a live chunk failed; kept at its writable upload key",
    );
    return key;
  }
}

/** A free too-small upload is never measured or counted, but still frozen; null when unlimited. */
export async function freezeUnplayable(
  d: ConversationsDeps,
  conv: { id: string; project_id: string },
  key: string,
): Promise<string | null> {
  return measureFailed(d, conv.id, async () => {
    if (!(await allowanceForProject(d.db, conv.project_id, d.now()))) return null;
    return freeze(d, conv.id, key);
  });
}

async function drop(d: ConversationsDeps, conversationId: string, keys: readonly string[]) {
  for (const key of keys)
    await d.audio
      .delete(key)
      .catch((err) =>
        d.logger.error({ err, key, conversationId }, "deleting a confirmed upload's object failed"),
      );
}

/**
 * Measures an upload's frozen copy and, under the account lock, reserves its seconds and
 * writes its chunk. Null for unlimited; a refused file is deleted from the bucket.
 */
export async function reserveUpload(
  d: ConversationsDeps,
  conv: { id: string; project_id: string },
  key: string,
  bytes: number,
  insert: InsertChunk,
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
  const refuse = async (err: Error, keys: readonly string[]): Promise<never> => {
    await drop(d, conv.id, keys);
    throw err;
  };
  // Also for a conversation that already has audio: only the recording project takes files.
  if (pre.home !== conv.project_id) return refuse(freeLimitError("recording_project"), [key]);
  const frozen = await measureFailed(d, conv.id, () => freeze(d, conv.id, key));
  const measured = await measureFailed(d, conv.id, () => measureUpload(d, frozen, bytes)).catch(
    (err) => refuse(err, [frozen]),
  );
  if ("unreadable" in measured) {
    d.logger.warn(
      { conversationId: conv.id, reason: measured.reason, signal: "free_audio.upload_unreadable" },
      "upload could not be read as audio",
    );
    return refuse(new BadRequestError("upload.unreadable"), [key, frozen]);
  }
  const reserved = Math.round(measured.seconds);
  // A second of tolerance: decoders overrun an exact-length file by a few ms.
  if (measured.seconds > fileLimit + FILE_TOLERANCE_S)
    return refuse(
      freeLimitError("audio_conversation", { file_seconds: reserved, limit_seconds: fileLimit }),
      [key, frozen],
    );
  try {
    const chunk = await withAllowanceLock(d.db, a, async (tx) => {
      const t = await take(tx, a, "audio_seconds", reserved, monthLimit);
      if (!t.ok)
        throw freeLimitError("audio_month", {
          file_seconds: reserved,
          remaining_seconds: Math.max(0, t.limit - t.used),
        });
      // The file joins whatever the conversation already holds.
      if ((await recordedSeconds(tx, conv.id)) + measured.seconds > fileLimit + FILE_TOLERANCE_S)
        throw freeLimitError("audio_conversation", {
          file_seconds: reserved,
          limit_seconds: fileLimit,
        });
      return insert(tx, { key: frozen, audioSeconds: measured.seconds, error: null });
    });
    await drop(d, conv.id, [key]);
    return chunk;
  } catch (err) {
    return refuse(err as Error, isFreeLimit(err) ? [key, frozen] : [frozen]);
  }
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

// The recorder's 30 s chunk is under this at any speech bitrate; larger never passes unmeasured.
export const LIVE_CHUNK_BYTES = 1024 * 1024;

/** Metered seconds, plus each live chunk still waiting for its length at the most one holds. */
export async function recordedSeconds(db: Db, conversationId: string): Promise<number> {
  const c = schema.conversation_chunk;
  const [row] = await db
    .select({
      s: sql<string>`coalesce(sum(${c.audio_seconds}), 0) + ${sql.raw(String(LIVE_CHUNK_MAX_SECONDS))} * count(*) filter (
        where ${c.audio_seconds} is null and ${c.path} is not null and ${c.error} is null
          and ${c.transcript} is null and ${c.source} = ${LIVE_SOURCE})`,
    })
    .from(c)
    .where(eq(c.conversation_id, conversationId));
  return Number(row?.s ?? 0);
}

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
  const conv = await recordedSeconds(db, conversationId);
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
): Promise<AudioRefusal | null> {
  let v: LiveVerdict;
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    v = await liveVerdict(d.db, a, await freeLimits(d.db, d.now, d.logger), conv.id);
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
 * A free account's live chunk: frozen, measured, then checked and counted under the account
 * lock in the transaction that writes it, so confirms cannot outrun the limits. A failing
 * check or measurement keeps the chunk unmetered for the pipeline (rule 3).
 */
export async function confirmLiveChunk(
  d: ConversationsDeps,
  a: AllowanceAccount,
  conv: { id: string; project_id: string },
  key: string,
  bytes: number,
  insert: InsertChunk,
): Promise<{ chunk: ChunkRow; recordingStop: AudioRefusal | null }> {
  const frozen = await freezeLive(d, conv.id, key, bytes);
  const kept = frozen === key ? [key] : [key, frozen];
  const failed = (signal: string) => (err: unknown) => {
    d.logger.error({ err, conversationId: conv.id, signal }, "live chunk check failed");
    return null;
  };
  try {
    const measured = await measureUpload(d, frozen, bytes).catch(
      failed("free_audio.live_measure_failed"),
    );
    const s = measured && "seconds" in measured ? measured.seconds : null;
    const limits = await freeLimits(d.db, d.now, d.logger).catch(
      failed("free_audio.live_check_failed"),
    );
    const out = await withAllowanceLock(d.db, a, async (tx) => {
      const v = limits
        ? await tx
            .transaction((sp) => liveVerdict(sp as unknown as Db, a, limits, conv.id))
            .catch(failed("free_audio.live_check_failed"))
        : null;
      if (v?.refuse) throw freeLimitError(v.refuse);
      let row: FrozenChunk = { key: frozen, audioSeconds: null, error: null };
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
      return { chunk: await insert(tx, row), recordingStop: v?.stop ?? null };
    });
    if (frozen !== key) await drop(d, conv.id, [key]);
    return out;
  } catch (err) {
    if (isFreeLimit(err)) await drop(d, conv.id, kept);
    else if (frozen !== key) await drop(d, conv.id, [frozen]);
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
        (await recordedSeconds(db, chunk.conversation_id)) <= convLimit &&
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
