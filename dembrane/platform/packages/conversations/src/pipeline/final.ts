import { AudioError, fileFormatOf, planPieces } from "@dembrane/audio";
import { schema } from "@dembrane/db";
import type {
  EditStats,
  FinalProvider,
  FinalTranscriber,
  FinalUsage,
  RetryStats,
  Sentence,
} from "@dembrane/transcription";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { mergeConversationAudio, NoContent, NoMergeableChunks } from "../merge";
import { conversationStore, FINAL_GAVE_UP } from "../storage";
import type { PipelineDeps } from "./steps";
import { pausesOf, recordRetries, recordStatus, spanCutter, stripNul } from "./steps";

const { conversation, conversation_chunk, conversation_final_transcript, project } = schema;

/**
 * The final pass: after a conversation is finished and every live chunk is transcribed,
 * the whole recording is transcribed once more, in one piece or in pieces cut where nobody
 * speaks, and that becomes the transcript people read. The live text stays stored.
 */
export interface FinalSettings {
  /** Providers to run, in order. The first is the record, the others are kept beside it. */
  readonly providers: readonly FinalProvider[];
  readonly transcribers: Partial<Record<FinalProvider, FinalTranscriber>>;
  /** Redaction on text, for anonymised conversations (their final text has no timings). */
  readonly redact: (
    text: string,
    opts: {
      language: string | null;
      hotwords: readonly string[] | null;
      customGuidancePrompt: string | null;
    },
  ) => Promise<string>;
  /**
   * The text pass: edits inside sentences only, ids and times untouched. Runs for the
   * providers listed (Whisper's words are the ones that benefit); absent means off.
   */
  readonly edit?: {
    readonly providers: readonly FinalProvider[];
    run(
      sentences: readonly Sentence[],
      ctx: { language: string | null; keyTerms: readonly string[] | null },
    ): Promise<{ sentences: Sentence[]; stats: EditStats }>;
  };
}

/** Names the chunk list a final transcript was made from; the hand-over names its run the same way. */
export function chunkListHash(ids: string | null): string {
  return new Bun.CryptoHasher("sha256")
    .update(ids ?? "")
    .digest("hex")
    .slice(0, 16);
}

export async function currentChunkHash(d: Pick<PipelineDeps, "db">, conversationId: string) {
  const [row] = await d.db
    .select({
      ids: sql<
        string | null
      >`string_agg(${conversation_chunk.id}::text, ',' order by ${conversation_chunk.id})`,
    })
    .from(conversation_chunk)
    .where(eq(conversation_chunk.conversation_id, conversationId));
  return chunkListHash(row?.ids ?? null);
}

// Names the merged file of one chunk list, so the providers of one conversation share it
// and a retried merge overwrites its own file.
const FINAL_NAMESPACE = "9c4e2d7a-61b8-4f0e-a3d5-2b8f7e1c6a90";
const URL_EXPIRES_S = 3 * 3600;

export interface FinalPlan {
  readonly duration: number;
  readonly pieces: readonly {
    readonly key: string;
    readonly start: number;
    readonly duration: number;
    readonly hardCut: boolean;
  }[];
}

/**
 * Merges the chunks, finds the pauses and cuts the merged file into pieces the provider
 * takes in one request. Returns null when there is nothing to transcribe: no audio, or the
 * chunk list changed since the hand-over. A single chunk still gets its pass: the sentence
 * times for the player, the text pass and the one redaction all come from it.
 * Idempotent: the merged file and the pieces are named from the chunk list.
 */
export async function planFinal(
  d: PipelineDeps,
  conversationId: string,
  hash: string,
  transcriber: FinalTranscriber,
): Promise<FinalPlan | null> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv) return null;
  if ((await currentChunkHash(d, conversationId)) !== hash) return null;
  const [audioChunks] = await d.db
    .select({ n: count() })
    .from(conversation_chunk)
    .where(
      and(
        eq(conversation_chunk.conversation_id, conversationId),
        isNotNull(conversation_chunk.path),
      ),
    );
  if ((audioChunks?.n ?? 0) < 1) return null;

  let merged: { path: string; duration: number };
  try {
    merged = await mergeConversationAudio(
      d,
      conversationId,
      Bun.randomUUIDv5(`${conversationId}:${hash}`, FINAL_NAMESPACE),
    );
  } catch (err) {
    if (err instanceof NoContent || err instanceof NoMergeableChunks) return null;
    throw err;
  }
  const key = d.audioUrls.keyOf(merged.path);
  const size = await d.audio.size(key);
  if (size === null) throw new AudioError("transient", `merged file ${key} not in the bucket`);
  const source = {
    url: d.audio.presignDownload(key, { expiresInSeconds: URL_EXPIRES_S }),
    format: fileFormatOf(merged.path),
    name: key,
  };
  const found = await d.media.silences({ source });
  const duration = found.duration > 0 ? found.duration : merged.duration;
  if (!(duration > 0)) return null;

  const bytesPerSecond = size / duration;
  const maxSeconds = Math.max(
    1,
    Math.min(
      transcriber.limits.maxSeconds,
      Math.floor(transcriber.limits.maxBytes / bytesPerSecond),
    ),
  );
  const planned = planPieces(duration, found.silences, maxSeconds, found.quiet);
  if (planned.length === 1)
    return { duration, pieces: [{ key, start: 0, duration, hardCut: false }] };

  const pieces = planned.map((p, i) => ({
    ...p,
    key: `final/${conversationId}/${hash}/${i}.mp3`,
  }));
  await d.media.split({
    source,
    pieces: pieces.map((p) => ({
      start: p.start,
      duration: p.duration,
      target: {
        url: d.audio.presignUpload(p.key, {
          contentType: "audio/mpeg",
          expiresInSeconds: URL_EXPIRES_S,
        }),
        contentType: "audio/mpeg",
      },
    })),
  });
  for (const p of pieces)
    if ((await d.audio.size(p.key)) === null)
      throw new AudioError("transient", `upload verification failed for ${p.key}`);
  return { duration, pieces };
}

export interface FinalPart {
  readonly text: string;
  /** Sentences with times in the merged file; empty when redaction ran on the text. */
  readonly sentences: readonly Sentence[];
  readonly usage: FinalUsage;
  readonly model: string | null;
  /** What the confidence retries did for this piece, when they were on. */
  readonly retry?: RetryStats;
}

export interface FinalContext {
  readonly language: string;
  readonly keyTerms: readonly string[] | null;
  readonly anonymized: boolean;
  readonly customGuidancePrompt: string | null;
}

/** What the project says about this conversation's language, key terms and redaction, read once per run. */
export async function loadFinalContext(
  d: Pick<PipelineDeps, "db">,
  conversationId: string,
): Promise<FinalContext> {
  const [row] = await d.db
    .select({
      language: project.language,
      prompt: project.default_conversation_transcript_prompt,
      anonymized: conversation.is_anonymized,
    })
    .from(conversation)
    .innerJoin(project, eq(project.id, conversation.project_id))
    .where(eq(conversation.id, conversationId))
    .limit(1);
  if (!row) throw new Error("Conversation not found");
  return {
    language: row.language || "en",
    keyTerms: row.prompt
      ? row.prompt
          .split(",")
          .map((w) => w.trim())
          .filter(Boolean)
      : null,
    anonymized: Boolean(row.anonymized),
    customGuidancePrompt: row.prompt,
  };
}

/** One piece through the provider; its sentences keep times in the merged file. Redaction is not here: it runs once, on the final text. */
export async function transcribeFinalPiece(
  d: PipelineDeps,
  piece: FinalPlan["pieces"][number],
  transcriber: FinalTranscriber,
  ctx: FinalContext,
): Promise<FinalPart> {
  const blob = await d.audio.get(piece.key);
  if (!blob) throw new Error(`audio ${piece.key} not found in storage`);
  const out = await transcriber.transcribe({
    audio: new Uint8Array(await blob.arrayBuffer()),
    seconds: piece.duration,
    language: ctx.language,
    hotwords: ctx.keyTerms,
    cutSpan: spanCutter(d, piece.key, `final-${piece.key.replaceAll("/", "-")}`),
    pauses: pausesOf(d, piece.key),
  });
  const sentences = out.sentences.map((s) => ({
    start: Math.round((s.start + piece.start) * 100) / 100,
    end: Math.round((s.end + piece.start) * 100) / 100,
    text: s.text,
  }));
  return {
    text: sentences.map((s) => s.text).join(" "),
    sentences,
    usage: out.usage,
    model: out.model,
    ...(out.retry && { retry: out.retry }),
  };
}

export interface FinalText {
  /** The sentences the player highlights; empty when the text was redacted, since the audio still holds the names. */
  readonly sentences: readonly Sentence[];
  readonly text: string;
  readonly edit: EditStats | null;
  /** Whisper's sentences before the text pass changed them; null when it changed none or the text was redacted. */
  readonly raw: readonly Sentence[] | null;
}

/** The text pass over all pieces' sentences, when it is on for this provider. Ids are positions: they and the times survive. */
export async function editFinal(
  final: FinalSettings,
  provider: FinalProvider,
  parts: readonly FinalPart[],
  ctx: FinalContext,
): Promise<{ sentences: Sentence[]; edit: EditStats | null; raw: Sentence[] | null }> {
  const all = parts.flatMap((p) => p.sentences);
  if (!final.edit?.providers.includes(provider) || !all.length)
    return { sentences: all, edit: null, raw: null };
  const r = await final.edit.run(all, { language: ctx.language, keyTerms: ctx.keyTerms });
  const changed = r.sentences.some((s, i) => s.text !== all[i]?.text);
  return { sentences: r.sentences, edit: r.stats, raw: changed && !ctx.anonymized ? all : null };
}

// One redaction call reads about this much text: the model keeps its attention and its answer fits.
const REDACT_CHARS = 3000;

/** Redaction once on the final text, in paragraphs of about 3000 characters cut at sentence ends. */
export async function redactFinal(
  final: FinalSettings,
  sentences: readonly Sentence[],
  ctx: FinalContext,
): Promise<string> {
  const groups: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.text.length > REDACT_CHARS) {
      groups.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s.text}` : s.text;
  }
  if (cur) groups.push(cur);
  const out: string[] = [];
  for (const g of groups)
    out.push(
      await final.redact(g, {
        language: ctx.language,
        hotwords: ctx.keyTerms,
        customGuidancePrompt: ctx.customGuidancePrompt,
      }),
    );
  return out.join("\n");
}

/**
 * Keeps the assembled transcript beside the chunks. A no-op when the chunk list changed
 * meanwhile (the next hand-over starts its own run) or when the providers heard nothing,
 * so an empty answer never replaces live text. Returns whether a row was written.
 */
export async function storeFinal(
  d: PipelineDeps,
  conversationId: string,
  hash: string,
  provider: FinalProvider,
  record: boolean,
  plan: FinalPlan,
  parts: readonly FinalPart[],
  assembled: FinalText,
): Promise<boolean> {
  // Postgres text cannot hold a NUL byte, which Gemini now and then emits.
  const text = (stripNul(assembled.text) as string).trim();
  if (!text) {
    d.logger.warn({ conversationId, provider }, "final transcript heard nothing; live text stays");
    return false;
  }
  if ((await currentChunkHash(d, conversationId)) !== hash) return false;
  const sentences = stripNul(assembled.sentences) as Sentence[];
  const usage = parts.reduce(
    (t, p) => ({
      seconds: t.seconds + p.usage.seconds,
      inputTokens: (t.inputTokens ?? 0) + (p.usage.inputTokens ?? 0),
      outputTokens: (t.outputTokens ?? 0) + (p.usage.outputTokens ?? 0),
    }),
    { seconds: 0, inputTokens: 0 as number | null, outputTokens: 0 as number | null },
  );
  const retries = parts.reduce(
    (t, p) => ({
      spans: t.spans + (p.retry?.spans ?? 0),
      attempts: t.attempts + (p.retry?.attempts ?? 0),
      improved: t.improved + (p.retry?.improved ?? 0),
      kept: t.kept + (p.retry?.kept ?? 0),
      failed: t.failed + (p.retry?.failed ?? 0),
      seconds: t.seconds + (p.retry?.seconds ?? 0),
    }),
    { spans: 0, attempts: 0, improved: 0, kept: 0, failed: 0, seconds: 0 },
  );
  const now = d.now().toISOString();
  const values = {
    model: parts.find((p) => p.model)?.model ?? null,
    chunk_hash: hash,
    is_record: record,
    text,
    sentences: sentences.length ? sentences : null,
    raw_sentences: assembled.raw?.length ? (stripNul(assembled.raw) as Sentence[]) : null,
    audio_seconds: plan.duration,
    usage: {
      ...usage,
      pieces: plan.pieces.length,
      hardCuts: plan.pieces.filter((p) => p.hardCut).length,
      ...(assembled.edit && { textPass: assembled.edit }),
      ...(retries.spans || retries.attempts ? { retries } : {}),
    },
    updated_at: now,
  };
  await d.db
    .insert(conversation_final_transcript)
    .values({ conversation_id: conversationId, provider, ...values })
    .onConflictDoUpdate({
      target: [
        conversation_final_transcript.conversation_id,
        conversation_final_transcript.provider,
      ],
      set: values,
    });
  // Only one row per conversation is the record; a run for another provider that was the
  // record before a setting change gives the flag up.
  if (record)
    await d.db
      .update(conversation_final_transcript)
      .set({ is_record: false })
      .where(
        and(
          eq(conversation_final_transcript.conversation_id, conversationId),
          sql`${conversation_final_transcript.provider} <> ${provider}`,
        ),
      );
  // Readers' cached token count was of the live text.
  if (record)
    await d.db
      .update(conversation)
      .set({ token_count: null, updated_at: now })
      .where(eq(conversation.id, conversationId));
  // Counted once per conversation and provider run that wrote: the first provider's retries are the record's.
  if (record) await recordRetries(d, conversationId, "final", retries);
  await recordStatus(d.db, {
    conversationId,
    event: "task_final_transcript.completed",
    message: `${provider}, ${plan.pieces.length} piece${plan.pieces.length === 1 ? "" : "s"}`,
    durationMs: 0,
    now: d.now(),
  });
  return true;
}

/**
 * The record's run ended without a final transcript: the dashboard stops saying one is on its
 * way. A run whose chunk list changed meanwhile says nothing, since the next hand-over starts
 * its own.
 */
export async function markFinalGaveUp(
  d: PipelineDeps,
  conversationId: string,
  hash: string,
): Promise<void> {
  if ((await currentChunkHash(d, conversationId)) !== hash) return;
  await recordStatus(d.db, {
    conversationId,
    event: FINAL_GAVE_UP,
    message: "the live text stays",
    durationMs: 0,
    now: d.now(),
  });
}
