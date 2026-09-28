import { BadRequestError, ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import type { ConversationsDeps } from "./deps";
import { processChunk } from "./pipeline/defs";
import { type ChunkRow, type ConversationRow, conversationStore, transaction } from "./storage";

const { conversation, conversation_chunk } = schema;

export const NOT_OPEN = "Conversation not open for participation";
// How far ahead of server time a client-supplied timestamp may sit.
const SKEW_TOLERANCE_MS = 5 * 60_000;

/** A service error the routes answer with 400 and its text (ConversationServiceException). */
export class ChunkError extends BadRequestError {}

export interface NewChunk {
  readonly conversationId: string;
  readonly timestamp: Date;
  readonly source: string;
  /** The stored path of audio already in the bucket (presigned upload or server save). */
  readonly fileUrl?: string | null;
  readonly transcript?: string | null;
  /** Set on the row in the same commit, for audio the API already knows is unusable. */
  readonly error?: string | null;
}

/**
 * conversation_service.create_chunk: the chunk row, its side effects on the conversation,
 * and the pipeline run for audio, all in one transaction so a chunk never exists without
 * its processing (the Python API sent the task after the row; a crash in between left an
 * orphan chunk the repair crons had to find).
 */
export async function createChunk(
  d: Pick<ConversationsDeps, "db" | "jobs" | "now">,
  input: NewChunk,
  opts: { chunkId: string; usePiiRedaction?: boolean } = { chunkId: "" },
): Promise<ChunkRow> {
  const store = conversationStore(d.db);
  const conv = await store.conversation(input.conversationId);
  if (!conv) throw new NotFoundError("Conversation not found");
  const now = d.now();

  // A conversation finished and merged (auto-finished after a pause) gets more audio:
  // reset it so finishing again merges and summarises every segment.
  if (conv.is_finished && conv.merged_audio_path) {
    await d.db
      .update(conversation)
      .set({
        is_finished: false,
        is_all_chunks_transcribed: false,
        merged_audio_path: null,
        duration: null,
        summary: null,
        updated_at: now.toISOString(),
      })
      .where(eq(conversation.id, conv.id));
  }

  const project = await store.project(conv.project_id);
  // project_service raised ProjectNotFoundException here, which no route caught.
  if (!project) throw new Error(`project ${conv.project_id} of conversation ${conv.id} not found`);
  if (project.is_conversation_allowed !== true) throw new ForbiddenError(NOT_OPEN);

  const fileUrl = input.fileUrl ?? null;
  const hasFile = Boolean(fileUrl?.trim());
  const hasTranscript = Boolean(input.transcript?.trim());
  if (!hasFile && !hasTranscript)
    throw new ChunkError(
      "Chunk must have either an audio file (file_obj or file_url) or a transcript.",
    );

  return transaction(d.db, async (tx) => {
    const [row] = await tx.db
      .insert(conversation_chunk)
      .values({
        id: opts.chunkId,
        conversation_id: conv.id,
        timestamp: input.timestamp.toISOString(),
        path: fileUrl,
        source: input.source,
        transcript: input.transcript ?? null,
        error: input.error ?? null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .returning();
    // Only audio starts a recording; a typed message is not a recording start.
    if (hasFile) await stampRecordingStartedAt(tx.db, conv, input.timestamp, now);
    // Transcript text changed: the persisted token count is stale.
    if (hasTranscript)
      await tx.db
        .update(conversation)
        .set({ token_count: null, updated_at: now.toISOString() })
        .where(eq(conversation.id, conv.id));
    if (hasFile)
      await d.jobs.enqueue(
        processChunk,
        { chunkId: opts.chunkId, usePiiRedaction: opts.usePiiRedaction ?? false },
        { tx: tx.sql, workflowId: `conversations.chunk:${opts.chunkId}` },
      );
    return row as ChunkRow;
  });
}

/**
 * stamp_recording_started_at from an untrusted chunk timestamp: fill-if-empty only,
 * clamped so a fast device clock cannot stamp the future and a slow one cannot stamp a
 * time before the conversation existed. The write is conditional because concurrent
 * chunks race; uploaded conversations are never stamped.
 */
export async function stampRecordingStartedAt(
  db: Db,
  conv: Pick<ConversationRow, "id" | "source" | "recording_started_at" | "created_at">,
  timestamp: Date,
  now: Date,
  allowMovingEarlier = false,
): Promise<void> {
  if (conv.source === "DASHBOARD_UPLOAD") return;
  if (!allowMovingEarlier && conv.recording_started_at !== null) return;
  let candidate = Number.isNaN(timestamp.getTime()) ? now : timestamp;
  candidate = new Date(Math.min(candidate.getTime(), now.getTime() + SKEW_TOLERANCE_MS));
  if (conv.created_at) {
    const created = new Date(conv.created_at);
    if (!Number.isNaN(created.getTime()) && created > candidate) candidate = created;
  }
  const stamp = candidate.toISOString();
  const when = allowMovingEarlier
    ? or(isNull(conversation.recording_started_at), gt(conversation.recording_started_at, stamp))
    : isNull(conversation.recording_started_at);
  await db
    .update(conversation)
    .set({ recording_started_at: stamp, updated_at: now.toISOString() })
    .where(
      and(
        eq(conversation.id, conv.id),
        or(isNull(conversation.source), ne(conversation.source, "DASHBOARD_UPLOAD")),
        when,
      ),
    );
}

/** delete_chunk: the row goes; a chunk that carried transcript text clears the token count. */
export async function deleteChunk(d: Pick<ConversationsDeps, "db" | "now">, chunkId: string) {
  const chunk = await conversationStore(d.db).chunk(chunkId);
  await d.db.delete(conversation_chunk).where(eq(conversation_chunk.id, chunkId));
  if (chunk?.conversation_id && (chunk.transcript ?? "").trim())
    await d.db
      .update(conversation)
      .set({ token_count: null, updated_at: d.now().toISOString() })
      .where(eq(conversation.id, chunk.conversation_id));
}
