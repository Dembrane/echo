import { AudioError, durationOf, fileFormatOf, MAX_CHUNK_BYTES } from "@dembrane/audio";
import { PaymentRequiredError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { isFinalAttempt } from "@dembrane/queue";
import type { ObjectStorage } from "@dembrane/storage";
import {
  isRecoverableTranscriptionError,
  type Transcriber,
  transcriptionFailureReason,
} from "@dembrane/transcription";
import { enqueueConversationEvent, type WebhookEvent, webhooksStorage } from "@dembrane/webhooks";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AudioUrls } from "../audio-urls";
import type { ConversationsDeps, JobSink } from "../deps";
import { LIVENESS_TTL_SECONDS } from "../live/presence";
import { mergeConversationAudio, NoContent, NoMergeableChunks } from "../merge";
import { type ChunkRow, conversationStore, type Tx, transaction } from "../storage";
import { computeIsOverCap } from "../tiers";
import { NO_TRANSCRIPT_SUMMARY, summarizeAndStore } from "../v1/summary";
import { computeTokenCount } from "../v1/token-count";
import { finalizeConversation } from "./defs";

const { conversation, conversation_chunk, processing_status, project, workspace, billing_account } =
  schema;

/** Everything the pipeline's steps touch; built once by the worker, faked in tests. */
export interface PipelineDeps {
  readonly db: Db;
  readonly audio: ObjectStorage;
  readonly audioUrls: AudioUrls;
  readonly media: ConversationsDeps["media"];
  readonly transcriber: Transcriber;
  readonly models: Models;
  readonly jobs: JobSink;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly webhooks: { readonly enabled: boolean; readonly dashboardUrl: string };
  /**
   * Told once per finished conversation whose every chunk is transcribed, inside the
   * transaction that marks it so. The worker books the project's popcorn read here.
   */
  readonly onTranscribed?: (
    tx: Tx["sql"],
    projectId: string,
    conversationId: string,
  ) => Promise<void>;
  /** Files above this are split before transcription; tests lower it to split small files. */
  readonly maxChunkBytes?: number;
}

// Namespace for the ids of split pieces: a retried split names its pieces the same way.
const PIECE_NAMESPACE = "5d0f3f0e-8f0a-4c43-9d8c-7c9a1a0b6e21";
export const pieceId = (chunkId: string, i: number) =>
  Bun.randomUUIDv5(`${chunkId}:${i}`, PIECE_NAMESPACE);
// A chunk is split into at most this many pieces (15 MB each: over 20 GB of audio).
const MAX_PIECES = 1500;
// Convert refuses inputs above this, as convert_and_save_to_s3 did.
const MAX_CONVERT_BYTES = 1000 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const URL_EXPIRES_S = 3 * 3600;
export const UNPLAYABLE = "Audio not playable";

/**
 * A processing_status row, as ProcessingStatusContext wrote them: only completions and
 * failures (they carry a duration), keyed to the conversation and chunk. The dashboard's
 * processing timeline reads these. At least once: a step retried after writing one
 * writes it again.
 */
export async function recordStatus(
  db: Db,
  row: {
    conversationId: string;
    chunkId?: string | null;
    event: string;
    message: string;
    durationMs: number;
    now: Date;
  },
): Promise<void> {
  await db
    .insert(processing_status)
    .values({
      conversation_id: row.conversationId,
      conversation_chunk_id: row.chunkId ?? null,
      event: row.event,
      message: row.message,
      duration_ms: row.durationMs,
      timestamp: row.now.toISOString(),
    })
    .catch(() => undefined);
}

/** Runs fn and records `<event>.completed` or `<event>.failed` with its duration. */
async function withStatus<T>(
  d: PipelineDeps,
  where: { conversationId: string; chunkId?: string | null },
  event: string,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const out = await fn();
    await recordStatus(d.db, {
      ...where,
      event: `${event}.completed`,
      message,
      durationMs: Math.round(performance.now() - started),
      now: d.now(),
    });
    return out;
  } catch (err) {
    await recordStatus(d.db, {
      ...where,
      event: `${event}.failed`,
      message: (err as Error).message,
      durationMs: Math.round(performance.now() - started),
      now: d.now(),
    });
    throw err;
  }
}

// ── chunk ────────────────────────────────────────────────────────────

export interface LoadedChunk {
  readonly skip: boolean;
  readonly conversationId: string | null;
  readonly anonymize: boolean;
}

/**
 * What the chunk run needs. A chunk that is gone, whose conversation is gone, or that
 * already carries a transcript or an error (a typed chunk, an unplayable upload) has
 * nothing to process; the run still hands over so a finished conversation finalizes.
 */
export async function loadChunk(d: PipelineDeps, chunkId: string): Promise<LoadedChunk> {
  const store = conversationStore(d.db);
  const chunk = await store.chunk(chunkId);
  if (!chunk) return { skip: true, conversationId: null, anonymize: false };
  const conv = await store.conversation(chunk.conversation_id);
  if (!conv) return { skip: true, conversationId: null, anonymize: false };
  const done = chunk.error !== null || chunk.transcript !== null || !chunk.path;
  return { skip: done, conversationId: conv.id, anonymize: Boolean(conv.is_anonymized) };
}

/**
 * split_audio_chunk: convert to mp3 when needed, then cut files above 15 MB into pieces of
 * equal duration. Returns the chunk ids to transcribe.
 *
 * Idempotent: the mp3 key is derived from the original key and overwritten on a retry;
 * the path update writes the same value; piece ids and keys derive from the chunk id, the
 * piece rows are inserted with ON CONFLICT DO NOTHING and the original deleted in the
 * same transaction; a retry that finds the original gone returns the pieces it made.
 * Bad bytes (too small, too large, rejected by ffprobe) mark the chunk unplayable and
 * return no pieces instead of failing the run.
 */
export async function prepareChunk(d: PipelineDeps, chunkId: string): Promise<string[]> {
  const store = conversationStore(d.db);
  const chunk = await store.chunk(chunkId);
  if (!chunk) return existingPieces(d.db, chunkId);
  if (!chunk.path) return [];
  try {
    return await withStatus(
      d,
      { conversationId: chunk.conversation_id },
      "task_process_conversation_chunk.split_audio_chunk",
      `for chunk ${chunkId}`,
      () => convertAndSplit(d, chunk),
    );
  } catch (err) {
    if (err instanceof AudioError && err.unplayable) {
      d.logger.warn({ chunkId, err: err.message }, "chunk is unreadable, marking with error");
      await updateChunk(d, chunkId, chunk.conversation_id, { error: UNPLAYABLE });
      return [];
    }
    throw err;
  }
}

async function existingPieces(db: Db, chunkId: string): Promise<string[]> {
  const ids = Array.from({ length: MAX_PIECES }, (_, i) => pieceId(chunkId, i));
  const rows = await db
    .select({ id: conversation_chunk.id, path: conversation_chunk.path })
    .from(conversation_chunk)
    .where(inArray(conversation_chunk.id, ids));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.map((r) => r.id).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

async function convertAndSplit(d: PipelineDeps, chunk: ChunkRow): Promise<string[]> {
  const path = chunk.path as string;
  const format = fileFormatOf(path);
  let current = path;
  if (format !== "mp3") {
    const originalKey = d.audioUrls.keyOf(path);
    // The Python replaced every occurrence of the extension in the key; kept, so both
    // APIs name the converted file the same way.
    const outKey = originalKey.replaceAll(format, "mp3");
    const size = await d.audio.size(originalKey);
    if (size === null)
      throw new AudioError("transient", `input ${originalKey} not in the bucket yet`);
    if (size > MAX_CONVERT_BYTES)
      throw new AudioError(
        "too_large",
        `File size ${(size / 1048576).toFixed(1)}MB exceeds limit of 1000MB.`,
      );
    if (size < MIN_AUDIO_BYTES)
      throw new AudioError("too_small", `File size ${size} bytes is too small to process`);
    await d.media.convert({
      source: {
        url: d.audio.presignDownload(originalKey, { expiresInSeconds: URL_EXPIRES_S }),
        format,
        name: originalKey,
      },
      target: {
        url: d.audio.presignUpload(outKey, {
          contentType: "audio/mpeg",
          expiresInSeconds: URL_EXPIRES_S,
        }),
        contentType: "audio/mpeg",
      },
      outputFormat: "mp3",
    });
    current = d.audioUrls.fileUrl(outKey);
    await updateChunk(d, chunk.id, chunk.conversation_id, { path: current }, false);
  }
  const key = d.audioUrls.keyOf(current);
  const size = await d.audio.size(key);
  if (size === null) throw new AudioError("transient", `converted file ${key} not in the bucket`);
  const pieces = Math.ceil(size / (d.maxChunkBytes ?? MAX_CHUNK_BYTES));
  if (pieces <= 1) return [chunk.id];
  if (pieces > MAX_PIECES) throw new AudioError("too_large", `File splits into ${pieces} pieces`);

  const source = {
    url: d.audio.presignDownload(key, { expiresInSeconds: URL_EXPIRES_S }),
    format: "mp3" as const,
    name: key,
  };
  const probe = await d.media.probe(source);
  const duration = probe.format?.duration === undefined ? null : Number(probe.format.duration);
  if (duration === null || Number.isNaN(duration))
    throw new AudioError("value", "Duration not found in ffprobe output");
  const each = duration / pieces;
  const plan = Array.from({ length: pieces }, (_, i) => {
    const id = pieceId(chunk.id, i);
    const pieceKey = `chunks/${chunk.conversation_id}/${id}_${i}-of-${pieces}.mp3`;
    return { id, i, start: i * each, key: pieceKey };
  });
  await d.media.split({
    source,
    pieces: plan.map((p) => ({
      start: p.start,
      duration: each,
      target: {
        url: d.audio.presignUpload(p.key, {
          contentType: "audio/mpeg",
          expiresInSeconds: URL_EXPIRES_S,
        }),
        contentType: "audio/mpeg",
      },
    })),
  });
  for (const p of plan)
    if ((await d.audio.size(p.key)) === null)
      throw new AudioError("transient", `S3 upload verification failed for ${p.key}`);
  const shift = (iso: string | null, s: number) =>
    iso ? new Date(new Date(iso).getTime() + s * 1000).toISOString() : null;
  await transaction(d.db, async (tx) => {
    await tx.db
      .insert(conversation_chunk)
      .values(
        plan.map((p) => ({
          id: p.id,
          conversation_id: chunk.conversation_id,
          created_at: shift(chunk.created_at, p.start),
          timestamp: shift(chunk.timestamp, p.start) as string,
          path: d.audioUrls.fileUrl(p.key),
          source: chunk.source,
          updated_at: d.now().toISOString(),
        })),
      )
      .onConflictDoNothing();
    await tx.db.delete(conversation_chunk).where(eq(conversation_chunk.id, chunk.id));
  });
  return plan.map((p) => p.id);
}

/**
 * A write that must land: five attempts, 2 s doubling, as the pipeline's db steps retry.
 * Returns null once it lands, or the last error when every attempt failed.
 */
export async function retryWrite(
  write: () => Promise<unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<unknown> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await write();
      return null;
    } catch (err) {
      last = err;
      if (attempt < 5) await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  return last;
}

/**
 * conversation_service.update_chunk: strips NUL bytes (Postgres text cannot hold them and
 * Gemini occasionally emits them), and a new transcript clears the conversation's token
 * count so readers never see the count of the old text.
 */
export async function updateChunk(
  d: Pick<PipelineDeps, "db" | "now">,
  chunkId: string,
  conversationId: string,
  patch: Partial<Pick<ChunkRow, "path" | "transcript" | "error" | "diarization">>,
  bumpConversation = "transcript" in patch,
): Promise<void> {
  const now = d.now().toISOString();
  const clean = stripNul(patch) as typeof patch;
  await transaction(d.db, async (tx) => {
    await tx.db
      .update(conversation_chunk)
      .set({ ...clean, updated_at: now })
      .where(eq(conversation_chunk.id, chunkId));
    if (bumpConversation)
      await tx.db
        .update(conversation)
        .set({ token_count: null, updated_at: now })
        .where(eq(conversation.id, conversationId));
  });
}

function stripNul(v: unknown): unknown {
  if (typeof v === "string") return v.replaceAll("\u0000", "");
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)]));
  return v;
}

export interface TranscribeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * transcribe_conversation_chunk for one piece. A recoverable failure (no speech, bad audio,
 * truncated output) is saved on the chunk and returns normally so the run moves on; anything
 * else throws so the step retries, and is saved only on the last attempt. A saved error
 * counts the chunk as done, so saving one mid-retry let a finish summarise without it.
 *
 * Idempotent: the transcript is an update of one row; a retry after a crash overwrites
 * it with a new transcript of the same audio.
 */
export async function transcribePiece(
  d: PipelineDeps,
  chunkId: string,
  opts: { usePiiRedaction: boolean; anonymize: boolean },
): Promise<TranscribeOutcome> {
  const store = conversationStore(d.db);
  const chunk = await store.chunk(chunkId);
  if (!chunk) return { ok: false, reason: "gone" };
  return withStatus(
    d,
    { conversationId: chunk.conversation_id },
    "task_transcribe_chunk",
    `for chunk ${chunkId}`,
    async () => {
      try {
        if (!chunk.path) throw new Error(`chunk ${chunkId} has no path`);
        const [conv] = await d.db
          .select({
            language: project.language,
            prompt: project.default_conversation_transcript_prompt,
          })
          .from(conversation)
          .innerJoin(project, eq(project.id, conversation.project_id))
          .where(eq(conversation.id, chunk.conversation_id))
          .limit(1);
        if (!conv) throw new Error("Conversation not found");
        const key = d.audioUrls.keyOf(chunk.path);
        const blob = await d.audio.get(key);
        if (!blob) throw new Error(`audio ${key} not found in storage`);
        const result = await d.transcriber.transcribe({
          audio: new Uint8Array(await blob.arrayBuffer()),
          language: conv.language || "en",
          hotwords: conv.prompt ? conv.prompt.split(",").map((w) => w.trim()) : null,
          usePiiRedaction: opts.usePiiRedaction,
          anonymizeTranscripts: opts.anonymize,
          customGuidancePrompt: conv.prompt,
        });
        await updateChunk(d, chunkId, chunk.conversation_id, {
          transcript: result.transcript,
          diarization: {
            schema: "Dembrane-26-07-gemini",
            data: { note: result.note, raw: {}, error: null, models: result.models },
          },
        });
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        // This write is what marks the chunk done; lost, the chunk stays pending for good.
        if (isRecoverableTranscriptionError(err) || isFinalAttempt()) {
          const failure = await retryWrite(() =>
            updateChunk(d, chunkId, chunk.conversation_id, { error: message }, false),
          );
          if (failure)
            d.logger.error(
              {
                chunkId,
                conversationId: chunk.conversation_id,
                err: failure,
                signal: "chunk.error_not_saved",
              },
              "chunk error could not be saved; the chunk stays pending",
            );
        }
        d.logger.warn(
          {
            chunkId,
            conversationId: chunk.conversation_id,
            recoverable: isRecoverableTranscriptionError(err),
            reason: transcriptionFailureReason(err),
            signal: "chunk.transcription_failed",
          },
          "chunk transcription failed",
        );
        if (isRecoverableTranscriptionError(err))
          return { ok: false, reason: transcriptionFailureReason(err) };
        throw err;
      }
    },
  );
}

// ── hand-over to finalize ────────────────────────────────────────────

/** Chunks still waiting for a transcript: no transcript and no error (get_chunk_counts' pending). */
async function pendingChunks(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversation_chunk)
    .where(
      and(
        eq(conversation_chunk.conversation_id, conversationId),
        isNull(conversation_chunk.transcript),
        isNull(conversation_chunk.error),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The one place that decides a conversation is ready: finished and nothing pending.
 * Both the finish run and every chunk run call it with the conversation row locked, so
 * whichever commits last sees the other's work; the Python's version of this race is
 * why task_reconcile_transcribed_flag existed. The finalize run is queued in the same
 * transaction.
 */
export async function handOver(d: PipelineDeps, conversationId: string): Promise<boolean> {
  return transaction(d.db, async (tx) => {
    const locked = await tx.sql<
      { is_finished: boolean | null; is_all_chunks_transcribed: boolean | null }[]
    >`
      select is_finished, is_all_chunks_transcribed from conversation
      where id = ${conversationId} and deleted_at is null for update`;
    const row = locked[0];
    if (!row?.is_finished || row.is_all_chunks_transcribed) return false;
    if ((await pendingChunks(tx.db, conversationId)) > 0) return false;
    // The run id names the conversation and the chunks it finalizes: a second hand-over
    // of the same state joins the first run, while more audio after a reopen gets its own.
    const [set] = await tx.sql<{ ids: string | null }[]>`
      select string_agg(id::text, ',' order by id) as ids from conversation_chunk
      where conversation_id = ${conversationId}`;
    const state = new Bun.CryptoHasher("sha256")
      .update(set?.ids ?? "")
      .digest("hex")
      .slice(0, 16);
    await d.jobs.enqueue(
      finalizeConversation,
      { conversationId },
      { tx: tx.sql, workflowId: `conversations.finalize:${conversationId}:${state}` },
    );
    return true;
  });
}

// ── finish ───────────────────────────────────────────────────────────

/**
 * The finish signal (task_finish_conversation_hook): marks the conversation finished.
 * A conditional update is the claim, so of two concurrent finishes exactly one proceeds;
 * an already finished, missing or deleted conversation is left alone.
 */
export async function claimFinish(d: PipelineDeps, conversationId: string): Promise<boolean> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv) return false;
  const rows = await d.db
    .update(conversation)
    .set({ is_finished: true, updated_at: d.now().toISOString() })
    .where(
      and(
        eq(conversation.id, conv.id),
        isNull(conversation.deleted_at),
        or(isNull(conversation.is_finished), eq(conversation.is_finished, false)),
      ),
    )
    .returning({ id: conversation.id });
  return rows.length > 0;
}

/**
 * _stamp_over_cap: the soft-edge formula over the workspace's lifetime audio
 * hours, deleted conversations included, since deleting keeps billable duration.
 * A sample copy's invented conversations are no one's audio and do not count.
 * Deterministic in the database's state, so a retry writes the same value.
 */
export async function stampOverCap(d: PipelineDeps, conversationId: string): Promise<void> {
  const [row] = await d.db
    .select({
      duration: conversation.duration,
      workspaceId: project.workspace_id,
      tier: billing_account.tier,
    })
    .from(conversation)
    .innerJoin(project, and(eq(project.id, conversation.project_id), isNull(project.deleted_at)))
    .leftJoin(workspace, eq(workspace.id, project.workspace_id))
    .leftJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
    .where(and(eq(conversation.id, conversationId), isNull(conversation.deleted_at)))
    .limit(1);
  if (!row?.workspaceId) return;
  const [total] = await d.db
    .select({ seconds: sql<number>`coalesce(sum(${conversation.duration}), 0)::float8` })
    .from(conversation)
    .innerJoin(project, eq(project.id, conversation.project_id))
    .where(and(eq(project.workspace_id, row.workspaceId), eq(project.is_sample, false)));
  const overCap = computeIsOverCap(
    row.tier ?? "",
    (total?.seconds ?? 0) / 3600,
    (row.duration ?? 0) / 3600,
  );
  await d.db
    .update(conversation)
    .set({ is_over_cap: overCap, updated_at: d.now().toISOString() })
    .where(eq(conversation.id, conversationId));
}

// ── finalize ─────────────────────────────────────────────────────────

/**
 * task_finalize_conversation's claim: is_all_chunks_transcribed flips once, under the row
 * lock, only when the conversation is finished and nothing is pending, and the
 * conversation.transcribed webhooks are queued in the same commit. False means another
 * run finalized it or it is not ready; the caller stops.
 */
export async function claimFinalize(
  d: PipelineDeps,
  conversationId: string,
): Promise<string | null> {
  return transaction(d.db, async (tx) => {
    const [row] = await tx.sql<
      {
        project_id: string;
        is_finished: boolean | null;
        is_all_chunks_transcribed: boolean | null;
      }[]
    >`select project_id, is_finished, is_all_chunks_transcribed from conversation
      where id = ${conversationId} and deleted_at is null for update`;
    if (!row || row.is_all_chunks_transcribed || !row.is_finished) return null;
    if ((await pendingChunks(tx.db, conversationId)) > 0) return null;
    await tx.db
      .update(conversation)
      .set({ is_all_chunks_transcribed: true, updated_at: d.now().toISOString() })
      .where(eq(conversation.id, conversationId));
    await webhook(d, tx, row.project_id, conversationId, "conversation.transcribed");
    await d.onTranscribed?.(tx.sql, row.project_id, conversationId);
    return row.project_id;
  });
}

async function webhook(
  d: PipelineDeps,
  tx: Tx,
  projectId: string,
  conversationId: string,
  event: WebhookEvent,
) {
  await enqueueConversationEvent(
    {
      store: webhooksStorage(tx.db),
      jobs: d.jobs,
      now: d.now,
      enabled: d.webhooks.enabled,
      dashboardUrl: d.webhooks.dashboardUrl,
    },
    projectId,
    conversationId,
    event,
    { tx: tx.sql },
  );
}

/**
 * task_merge_conversation_chunks: the merged mp3 and the exact duration. No
 * chunks, no audio or only unreadable audio end the step quietly (a retry reads the same
 * bytes); a transient failure throws for the step to retry. The output name derives
 * from the run, so a retry overwrites its own file.
 */
export async function mergeAudio(d: PipelineDeps, conversationId: string, run: string) {
  try {
    await withStatus(d, { conversationId }, "task_merge_conversation_chunks", "", () =>
      mergeConversationAudio(d, conversationId, run),
    );
    return "merged";
  } catch (err) {
    if (err instanceof NoContent) return "no-content";
    if (err instanceof NoMergeableChunks) return "no-mergeable-audio";
    if ((err as Error).message === "Conversation not found") return "no-chunks";
    throw err;
  }
}

// Chunk probes in flight at once while measuring a conversation.
const MEASURE_CONCURRENCY = 8;

/**
 * The duration when the merge left none (it never ran, gave up or could not probe its
 * file): every audio chunk probed and summed, skipping chunks whose bytes are bad as the
 * merge does. A transient failure throws for the step to retry. Returns the seconds
 * written, or null when the conversation already has a duration or no chunk is readable.
 */
export async function measureDuration(
  d: PipelineDeps,
  conversationId: string,
): Promise<number | null> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv || conv.duration !== null) return null;
  const chunks = await d.db
    .select({ id: conversation_chunk.id, path: conversation_chunk.path })
    .from(conversation_chunk)
    .where(eq(conversation_chunk.conversation_id, conversationId));
  const paths = chunks
    .map((c) => c.path)
    .filter((p): p is string => Boolean(p?.startsWith("http")));
  if (!paths.length) return null;

  let total = 0;
  let readable = 0;
  const probeOne = async (p: string) => {
    const key = d.audioUrls.keyOf(p);
    try {
      const probe = await d.media.probe({
        url: d.audio.presignDownload(key, { expiresInSeconds: URL_EXPIRES_S }),
        format: fileFormatOf(p),
        name: key,
      });
      const seconds = durationOf(probe);
      if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return;
      total += seconds;
      readable++;
    } catch (err) {
      if (err instanceof AudioError && err.terminal) {
        d.logger.warn({ conversationId, key, err: err.message }, "chunk unreadable, not measured");
        return;
      }
      throw err;
    }
  };
  for (let i = 0; i < paths.length; i += MEASURE_CONCURRENCY)
    await Promise.all(paths.slice(i, i + MEASURE_CONCURRENCY).map(probeOne));
  if (!readable) {
    d.logger.warn(
      { conversationId, signal: "conversation.unmetered_duration" },
      "no audio chunk could be measured",
    );
    return null;
  }
  // Only fills a gap: a merge that lands meanwhile wrote the exact value.
  await d.db
    .update(conversation)
    .set({ duration: total, updated_at: d.now().toISOString() })
    .where(and(eq(conversation.id, conversationId), isNull(conversation.duration)));
  return total;
}

/**
 * task_summarize_conversation: skips a finished conversation that has a summary and a
 * tier-locked one (it stays in the catch-up set and summarises after an upgrade). The
 * no-transcript placeholder is not a summary: the catch-up retries it once text exists.
 * A finalize passes `fresh`: it claimed a new set of chunks, so a summary already there
 * is an earlier run's, written after the conversation reopened.
 * Returns whether a summary was written, so the webhook step knows to fire.
 */
export async function summarize(
  d: PipelineDeps,
  conversationId: string,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv) return false;
  if (!opts.fresh && conv.is_finished && conv.summary && conv.summary !== NO_TRANSCRIPT_SUMMARY)
    return false;
  try {
    await withStatus(d, { conversationId }, "task_summarize_conversation", "", () =>
      summarizeAndStore(d, conversationId),
    );
    return true;
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      d.logger.info(
        { conversationId },
        "conversation is tier-locked; summary waits for an upgrade",
      );
      return false;
    }
    throw err;
  }
}

export async function summarizedWebhook(d: PipelineDeps, conversationId: string): Promise<void> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv) return;
  await transaction(d.db, (tx) =>
    webhook(d, tx, conv.project_id, conversationId, "conversation.summarized"),
  );
}

/** task_compute_conversation_token_count: best effort; a failure is logged, never retried. */
export async function warmTokenCount(d: PipelineDeps, conversationId: string): Promise<void> {
  try {
    const conv = await conversationStore(d.db).conversation(conversationId);
    if (!conv || conv.token_count !== null) return;
    await computeTokenCount(d, conversationId);
  } catch (err) {
    d.logger.warn({ conversationId, err: (err as Error).message }, "token count warm-up failed");
  }
}

// ── sweeps ───────────────────────────────────────────────────────────

// Participants often open the portal well before recording (prod, 90 days: p95 18 min,
// p99 85 min). A conversation with no chunks stays open while the portal pings, and
// otherwise this long after it was opened (also the fallback with the monitor off).
const EMPTY_GRACE_MS = 30 * 60_000;

/**
 * collect_unfinished_conversations: unfinished, not deleted, in a live project, created
 * over five minutes ago and without a chunk in the last five minutes. One with no chunks
 * at all also needs EMPTY_GRACE_MS and no portal ping within the liveness TTL, so it is
 * not finalized empty while the participant is still getting ready. Oldest first.
 */
export async function idleConversations(db: Db, now: Date, limit = 100): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const emptyCutoff = new Date(now.getTime() - EMPTY_GRACE_MS).toISOString();
  const pingCutoff = new Date(now.getTime() - LIVENESS_TTL_SECONDS * 1000).toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from conversation c
    join project p on p.id = c.project_id and p.deleted_at is null
    where c.is_finished = false and c.deleted_at is null and c.created_at <= ${cutoff}
      and not exists (
        select 1 from conversation_chunk ch
        where ch.conversation_id = c.id and ch.timestamp >= ${cutoff})
      and (exists (select 1 from conversation_chunk ch where ch.conversation_id = c.id)
        or (c.created_at <= ${emptyCutoff} and not exists (
          select 1 from platform_presence pp
          where pp.kind = 'liveness' and pp.key = c.id::text and pp.seen_at >= ${pingCutoff})))
    order by c.created_at, c.id
    limit ${limit}`);
  return [...rows].map((r) => r.id);
}

/**
 * collect_unsummarized_conversations: transcribed, no summary, not locked (over the cap
 * on a tier without overage), not deleted, created over five minutes ago. The one
 * product-level catch-up kept: a locked conversation summarises once its workspace
 * upgrades, and a summary that failed all its retries gets another chance. The
 * no-transcript placeholder counts as no summary once a chunk has text, which repairs
 * conversations summarised before their last transcript landed.
 */
export async function unsummarizedConversations(db: Db, now: Date, limit = 50): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from conversation c
    join project p on p.id = c.project_id and p.deleted_at is null
    left join workspace w on w.id = p.workspace_id
    left join billing_account b on b.id = w.billing_account_id
    where c.is_all_chunks_transcribed = true
      and (c.summary is null or c.summary = ''
           or (c.summary = ${NO_TRANSCRIPT_SUMMARY} and exists (
             select 1 from conversation_chunk ch
             where ch.conversation_id = c.id and octet_length(ch.transcript) > 0)))
      and (c.is_over_cap is not true or b.tier is null
           or b.tier in ('innovator', 'changemaker', 'guardian'))
      and c.deleted_at is null and c.created_at <= ${cutoff}
    order by c.created_at, c.id
    limit ${limit}`);
  return [...rows].map((r) => r.id);
}

export type { Models };
