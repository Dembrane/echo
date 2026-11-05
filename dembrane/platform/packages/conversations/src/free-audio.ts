import {
  type AllowanceAccount,
  add,
  aiBudgetFor,
  allowanceForProject,
  type FreeLimits,
  freeLimitError,
  freeLimits,
  isFreeLimit,
  isSampleProject,
  recordingProject,
  take,
  type UsageKey,
  usedThisPeriod,
  withAllowanceLock,
} from "@dembrane/allowance";
import { AudioError, fileFormatOf, type Measured, measureSeconds } from "@dembrane/audio";
import { BadRequestError, StatusError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { ConversationsDeps } from "./deps";
import type { PipelineDeps } from "./pipeline/steps";
import { type ChunkRow, type ConversationRow, conversationStore } from "./storage";

export const LIVE_SOURCE = "PORTAL_AUDIO";
// Past the limit by this much before a live chunk is refused: the portal stops itself first.
export const LIVE_GRACE_SECONDS = 120;
// Set on a chunk the free limit kept out of the transcript.
export const FREE_LIMIT_SKIPPED = "Over the free plan's recording limit";
export type AudioRefusal = "audio_month" | "audio_conversation" | "recording_project" | "ai_budget";

type AudioDeps = Pick<ConversationsDeps, "db" | "now"> & Partial<Pick<ConversationsDeps, "logger">>;
type Usage = Readonly<Record<UsageKey, number>>;

interface Verdict {
  readonly a: AllowanceAccount;
  readonly limits: FreeLimits;
  readonly refusal: AudioRefusal | null;
  /** This period's usage, when the verdict read it. */
  readonly used?: Usage;
}

async function verdict(d: AudioDeps, projectId: string): Promise<Verdict | null> {
  const a = await allowanceForProject(d.db, projectId, d.now());
  if (!a) return null;
  const limits = await freeLimits(d.db, d.now, d.logger);
  if ((await recordingProject(d.db, a)) !== projectId)
    return { a, limits, refusal: "recording_project" };
  const used = await usedThisPeriod(d.db, a);
  if (used.audio_seconds >= limits.audio_seconds_month)
    return { a, limits, refusal: "audio_month", used };
  return { a, limits, refusal: null, used };
}

// Read only, on the caller's account: a sample never runs out, a failed read lets audio through.
async function aiBudgetGone(
  d: AudioDeps,
  a: AllowanceAccount,
  projectId: string,
  used?: Usage,
): Promise<boolean> {
  try {
    const [sample, budget] = await Promise.all([
      isSampleProject(d.db, projectId),
      aiBudgetFor(d.db, a, d.now(), used),
    ]);
    return !sample && budget.exhausted;
  } catch (err) {
    d.logger?.error(
      { err, projectId, signal: "free_audio.ai_budget_check_failed" },
      "AI budget check failed",
    );
    return false;
  }
}

type Closable = Pick<
  ConversationRow,
  "is_finished" | "is_all_chunks_transcribed" | "merged_audio_path"
>;

// Finished and finalized: more audio or text would reopen it and summarise it again.
export function isClosed(c: Partial<Closable>): boolean {
  return Boolean(c.is_finished && (c.is_all_chunks_transcribed || c.merged_audio_path));
}

// At zero a finished, finalized conversation takes no more chunks: one would reopen it. Fails open.
export async function refuseClosedAtZero(
  d: AudioDeps,
  conv: Pick<ConversationRow, "id" | "project_id"> & Partial<Closable>,
): Promise<void> {
  if (!isClosed(conv)) return;
  let gone = false;
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    gone = a !== null && (await aiBudgetGone(d, a, conv.project_id));
  } catch (err) {
    d.logger?.error(
      { err, conversationId: conv.id, signal: "free_audio.closed_check_failed" },
      "closed conversation check failed",
    );
  }
  if (gone) throw freeLimitError("ai_budget");
}

// Past the grace from a recording's first AI budget stop, its chunks are refused.
function aiGraceOver(stoppedAt: string | null, now: Date): boolean {
  return stoppedAt !== null && now.getTime() > Date.parse(stoppedAt) + LIVE_GRACE_SECONDS * 1000;
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
  // No budget figures: participants never see them.
  if (await aiBudgetGone(d, v.a, projectId, v.used)) throw freeLimitError("ai_budget");
  return v.a;
}

/**
 * Typed text into an existing conversation, at a used-up AI budget: the same grace as a live
 * chunk while it is in progress, refused once it was finished and finalized. Fails open.
 */
export async function textChunkCheck(
  d: AudioDeps,
  conv: Pick<ConversationRow, "id" | "project_id" | "ai_stopped_at"> & Partial<Closable>,
): Promise<AudioRefusal | null> {
  let v: AiLive;
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    const gone = await aiBudgetGone(d, a, conv.project_id);
    if (gone && isClosed(conv)) v = { refuse: "ai_budget", stop: null };
    else if (!gone && conv.ai_stopped_at === null) return null;
    else v = await stampAiStop(d.db, conv.id, gone, d.now());
  } catch (err) {
    d.logger?.error(
      { err, conversationId: conv.id, signal: "free_audio.text_check_failed" },
      "typed text limit check failed",
    );
    return null;
  }
  if (v.refuse) throw freeLimitError(v.refuse);
  return v.stop;
}

// Typed text records nothing, so only a used-up AI budget refuses it, the same way as a recording.
export async function requireTextStart(d: AudioDeps, projectId: string): Promise<void> {
  const a = await allowanceForProject(d.db, projectId, d.now());
  if (a && (await aiBudgetGone(d, a, projectId))) throw freeLimitError("ai_budget");
}

// What the portal shows before starting; never throws.
export async function audioOpen(
  d: AudioDeps,
  projectId: string,
): Promise<{ open: boolean; aiAvailable: boolean; conversationLimitSeconds: number | null }> {
  try {
    const v = await verdict(d, projectId);
    if (!v) return { open: true, aiAvailable: true, conversationLimitSeconds: null };
    const ai = !(await aiBudgetGone(d, v.a, projectId, v.used));
    return {
      open: v.refusal === null && ai,
      aiAvailable: ai,
      conversationLimitSeconds: v.limits.audio_seconds_conversation,
    };
  } catch (err) {
    d.logger?.error(
      { err, projectId, signal: "free_audio.open_check_failed" },
      "audio open check failed",
    );
    return { open: true, aiAvailable: true, conversationLimitSeconds: null };
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
export const UPLOAD_MEASURE_TIMEOUT_MS = 200_000;
// A live chunk is about 30 s; past this it fails open like any measuring failure.
export const LIVE_MEASURE_TIMEOUT_MS = 15_000;

// Past ms the work's signal aborts, so the media request (and its ffmpeg) stops too.
function deadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AudioError("transient", `measuring timed out after ${ms} ms`));
      ctl.abort();
    }, ms);
  });
  return Promise.race([work(ctl.signal), late]).finally(() => clearTimeout(timer));
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
    return await deadline((signal) => measureSeconds(d.media, source, bytes, signal), ms);
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
  if (await aiBudgetGone(d, a, conv.project_id)) return refuse(freeLimitError("ai_budget"));
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
  readonly usage: Usage;
}

async function liveVerdict(
  db: Db,
  a: AllowanceAccount,
  limits: FreeLimits,
  conversationId: string,
): Promise<LiveVerdict> {
  const conv = await conversationSeconds(db, conversationId);
  const usage = await usedThisPeriod(db, a);
  const used = usage.audio_seconds;
  const convLimit = limits.audio_seconds_conversation;
  const monthLimit = limits.audio_seconds_month;
  const v = (refuse: AudioRefusal | null, stop: AudioRefusal | null) => ({
    refuse,
    stop,
    conv,
    usage,
  });
  if (conv >= convLimit + LIVE_GRACE_SECONDS) return v("audio_conversation", null);
  if (used >= monthLimit + LIVE_GRACE_SECONDS) return v("audio_month", null);
  if (conv >= convLimit) return v(null, "audio_conversation");
  if (used >= monthLimit) return v(null, "audio_month");
  return v(null, null);
}

type AiLive = Pick<LiveVerdict, "refuse" | "stop">;

// The AI budget's verdict for a live chunk, from the recording's first stop.
function aiLive(gone: boolean, stoppedAt: string | null, now: Date): AiLive {
  if (!gone) return { refuse: null, stop: null };
  return aiGraceOver(stoppedAt, now)
    ? { refuse: "ai_budget", stop: null }
    : { refuse: null, stop: "ai_budget" };
}

// Stamps the first stop, and clears it once there is room again, so a later stop gets its grace.
async function stampAiStop(db: Db, conversationId: string, gone: boolean, now: Date) {
  const { conversation } = schema;
  const [row] = await db
    .select({ at: conversation.ai_stopped_at })
    .from(conversation)
    .where(eq(conversation.id, conversationId));
  const at = row?.at ?? null;
  const next = gone ? (at ?? now.toISOString()) : null;
  if (next !== at)
    await db
      .update(conversation)
      .set({ ai_stopped_at: next })
      .where(eq(conversation.id, conversationId));
  return aiLive(gone, next, now);
}

/**
 * A live chunk's verdict: throws past the grace, returns the stop signal at the limit.
 * Fails open: any error reading the limits accepts the chunk.
 */
export async function liveChunkCheck(
  d: Pick<ConversationsDeps, "db" | "now" | "logger">,
  conv: { id: string; project_id: string; ai_stopped_at: string | null } & Partial<Closable>,
  opts: { home?: boolean } = {},
): Promise<AudioRefusal | null> {
  let v: AiLive;
  try {
    const a = await allowanceForProject(d.db, conv.project_id, d.now());
    if (!a) return null;
    let usage: Usage | undefined;
    // A started recording with no audio yet still belongs to the recording project.
    if (opts.home && (await recordingProject(d.db, a)) !== conv.project_id)
      v = { refuse: "recording_project", stop: null };
    else {
      const live = await liveVerdict(d.db, a, await freeLimits(d.db, d.now, d.logger), conv.id);
      v = live;
      usage = live.usage;
    }
    if (!v.refuse) {
      const gone = await aiBudgetGone(d, a, conv.project_id, usage);
      const ai: AiLive =
        gone && isClosed(conv)
          ? { refuse: "ai_budget", stop: null }
          : aiLive(gone, conv.ai_stopped_at, d.now());
      v = { refuse: ai.refuse, stop: v.stop ?? ai.stop };
    }
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
  conv: { id: string; project_id: string; ai_stopped_at: string | null } & Partial<Closable>,
  key: string,
  bytes: number,
  write: ChunkWrite,
): Promise<{ chunk: ChunkRow; recordingStop: AudioRefusal | null }> {
  const failed = (signal: string) => (err: unknown) => {
    d.logger.error({ err, conversationId: conv.id, signal }, "live chunk check failed");
    return null;
  };
  try {
    // None of the three throws; the AI check and the ledger below share the account's period.
    const [measured, limits, aiGone] = await Promise.all([
      measureUpload(d, key, bytes, true).catch(failed("free_audio.live_measure_failed")),
      freeLimits(d.db, d.now, d.logger).catch(failed("free_audio.live_check_failed")),
      aiBudgetGone(d, a, conv.project_id),
    ]);
    const s = measured && "seconds" in measured ? measured.seconds : null;
    return await withAllowanceLock(d.db, a, async (tx) => {
      const prior = await written(tx, conv.id, write.id);
      const v = limits
        ? await tx
            .transaction((sp) => liveVerdict(sp as unknown as Db, a, limits, conv.id))
            .catch(failed("free_audio.live_check_failed"))
        : null;
      const aiStop = aiGone ? "ai_budget" : null;
      if (prior) return { chunk: prior, recordingStop: (v && (v.refuse ?? v.stop)) ?? aiStop };
      if (v?.refuse) throw freeLimitError(v.refuse);
      // No grace for a finished recording: the chunk would reopen it.
      if (aiGone && isClosed(conv)) throw freeLimitError("ai_budget");
      // No stamp to write when the loaded one already fits; a failed stamp keeps the chunk and says stop.
      const ai =
        aiGone === (conv.ai_stopped_at !== null)
          ? aiLive(aiGone, conv.ai_stopped_at, d.now())
          : ((await tx
              .transaction((sp) => stampAiStop(sp as unknown as Db, conv.id, aiGone, d.now()))
              .catch(failed("free_audio.ai_stop_failed"))) ?? { refuse: null, stop: aiStop });
      if (ai.refuse) throw freeLimitError(ai.refuse);
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
      return { chunk: await write.insert(tx, row), recordingStop: v?.stop ?? ai.stop };
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
    return (
      v.refuse ??
      v.stop ??
      ((await aiBudgetGone(d, a, conv.project_id, v.usage)) ? "ai_budget" : null)
    );
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
