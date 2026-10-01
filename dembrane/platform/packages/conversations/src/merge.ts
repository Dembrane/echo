import { AudioError, fileFormatOf, type MediaSource } from "@dembrane/audio";
import { BadRequestError, type ErrorCode, NotFoundError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { asc, eq } from "drizzle-orm";
import { sanitizeFilenameComponent } from "./audio-urls";
import type { ConversationsDeps } from "./deps";

const { conversation, conversation_chunk } = schema;

// A presigned URL outlives the longest merge the media service accepts.
const URL_EXPIRES_S = 3 * 3600;

/** Every chunk failed to probe: a retry reads the same bytes, so callers stop (NoMergeableChunksException). */
export class NoMergeableChunks<C extends ErrorCode = ErrorCode> extends BadRequestError<C> {}
/** No chunk has audio (NoContentFoundException). */
export class NoContent<C extends ErrorCode = ErrorCode> extends NotFoundError<C> {}

export type MergeDeps = Pick<
  ConversationsDeps,
  "db" | "audio" | "audioUrls" | "media" | "logger" | "now"
>;

/**
 * get_conversation_content's merge: every chunk with an audio path, in time order, into
 * one mp3 at audio-conversations/merged-<id>-<run>.mp3, then merged_audio_path and
 * duration on the conversation. `run` names the output: the pipeline passes an id
 * derived from its workflow so a retried step overwrites its own file instead of
 * leaving a second one.
 */
export async function mergeConversationAudio(
  d: MergeDeps,
  conversationId: string,
  run: string,
): Promise<{ path: string; duration: number }> {
  const chunks = await d.db
    .select({
      id: conversation_chunk.id,
      path: conversation_chunk.path,
      error: conversation_chunk.error,
    })
    .from(conversation_chunk)
    .where(eq(conversation_chunk.conversation_id, conversationId))
    .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
    .limit(1000);
  if (!chunks.length) throw new NotFoundError("conversation.not_found");
  const paths = chunks
    .map((c) => c.path)
    .filter((p): p is string => Boolean(p?.startsWith("http")));
  if (!paths.length) throw new NoContent("conversation.no_content");

  const key = `audio-conversations/merged-${sanitizeFilenameComponent(conversationId)}-${run}.mp3`;
  let merged: { duration: number };
  try {
    const sources: MediaSource[] = paths.map((p) => {
      const k = d.audioUrls.keyOf(p);
      return {
        url: d.audio.presignDownload(k, { expiresInSeconds: URL_EXPIRES_S }),
        format: fileFormatOf(p),
        name: k,
      };
    });
    merged = await d.media.merge({
      sources,
      target: {
        url: d.audio.presignUpload(key, {
          contentType: "audio/mpeg",
          expiresInSeconds: URL_EXPIRES_S,
        }),
        contentType: "audio/mpeg",
      },
      outputFormat: "mp3",
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof AudioError && err.kind === "no_mergeable_chunks")
      throw new NoMergeableChunks("conversation.merge_failed", { params: { reason: msg } });
    if (err instanceof AudioError && err.kind === "transient") throw err;
    throw new BadRequestError("conversation.merge_failed", { params: { reason: msg } });
  }
  const path = d.audioUrls.fileUrl(key);
  await d.db
    .update(conversation)
    .set({
      merged_audio_path: path,
      // -1: the merged file could not be probed; the finalize run's measure step fills it.
      ...(merged.duration > 0 && { duration: merged.duration }),
      updated_at: d.now().toISOString(),
    })
    .where(eq(conversation.id, conversationId));
  return { path, duration: merged.duration };
}
