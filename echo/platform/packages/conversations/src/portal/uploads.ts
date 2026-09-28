import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@echo/core";

import { ChunkError, NOT_OPEN } from "../chunks";
import type { ConversationsDeps } from "../deps";
import { InternalError } from "../errors";
import { conversationStore } from "../storage";
import { addChunk } from "./service";

// Presigned form uploads: a 2 GB ceiling and an hour to finish, as the Python signed them.
const UPLOAD_MAX_BYTES = 2048 * 1024 * 1024;
const UPLOAD_EXPIRES_S = 3600;
// 40 upload URLs per conversation per minute: catches a looping recorder. The Python
// counted per process; this counts across instances with the same numbers.
const UPLOAD_URL_LIMIT = { name: "participant_upload_url", capacity: 40, windowSeconds: 60 };
// S3 is eventually consistent on some providers: look for the object three times.
const CONFIRM_RETRY_DELAYS_MS = [100, 500, 2000];
// Smaller than this is a recording stopped too quickly: kept as a chunk, marked unplayable.
const MIN_AUDIO_BYTES = 1024;

async function openConversation(d: Pick<ConversationsDeps, "db">, conversationId: string) {
  const store = conversationStore(d.db);
  const conv = await store.conversation(conversationId);
  if (!conv) throw new NotFoundError("Conversation not found");
  const project = await store.project(conv.project_id);
  // project_service raised ProjectNotFoundException, which these routes turned into 500s.
  if (!project) throw new Error(`project ${conv.project_id} not found`);
  return { conv, open: project.is_conversation_allowed === true };
}

/** check-s3: a presigned PUT the portal tries before recording, to learn the bucket is reachable. */
export async function probeUrl(d: ConversationsDeps, conversationId: string): Promise<string> {
  const { open } = await openConversation(d, conversationId);
  if (!open) throw new ForbiddenError(NOT_OPEN);
  try {
    return d.audio.presignUpload(`conversation/${conversationId}/probe`, {
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
  } catch (err) {
    d.logger.error({ err }, "presigning the S3 probe failed");
    throw new InternalError("Failed to generate S3 probe URL");
  }
}

/**
 * get-upload-url: a presigned form upload for one new chunk. The Python wrapped the
 * whole handler in one except, so a closed project and the rate limit both reached the
 * portal as this 500; the portal treats every failure the same way, so that is kept.
 */
export async function uploadUrl(
  d: ConversationsDeps,
  conversationId: string,
  filename: string,
  contentType: string,
) {
  try {
    if (!(await d.limiter.allow(UPLOAD_URL_LIMIT, conversationId))) {
      d.logger.warn({ conversationId }, "upload URL rate limit exceeded");
      throw new InternalError("Failed to generate upload URL");
    }
    const { open } = await openConversation(d, conversationId);
    if (!open) throw new InternalError("Failed to generate upload URL");
    const chunkId = newId();
    const safe = d.audioUrls.keyOf(filename);
    const key = `conversation/${conversationId}/chunks/${chunkId}-${safe}`;
    const post = d.audio.presignPost(key, {
      contentType,
      maxBytes: UPLOAD_MAX_BYTES,
      expiresInSeconds: UPLOAD_EXPIRES_S,
    });
    return {
      chunk_id: chunkId,
      upload_url: post.url,
      fields: post.fields,
      file_url: d.audioUrls.fileUrl(key),
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    if (!(err instanceof InternalError)) d.logger.error({ err }, "generating an upload URL failed");
    throw new InternalError("Failed to generate upload URL");
  }
}

/**
 * confirm-upload: the portal uploaded to the presigned form; check the object exists and
 * create the chunk. H-7: the Python accepted any key, so another conversation's audio
 * could be transcribed into this one and read back; the key must be the one issued for
 * this conversation and chunk.
 */
export async function confirmUpload(
  d: ConversationsDeps,
  conversationId: string,
  input: { chunkId: string; fileUrl: string; timestamp: Date; source: string },
) {
  let key: string;
  try {
    key = d.audioUrls.keyOf(input.fileUrl);
  } catch (err) {
    d.logger.error({ err }, "confirm-upload got an unusable file_url");
    throw new InternalError("Failed to confirm upload");
  }
  if (!key.startsWith(`conversation/${conversationId}/chunks/${input.chunkId}-`))
    throw new BadRequestError("File does not belong to this conversation");

  let size: number | null = null;
  for (const [attempt, delay] of CONFIRM_RETRY_DELAYS_MS.entries()) {
    size = await d.audio.size(key).catch(() => null);
    if (size !== null) break;
    if (attempt < CONFIRM_RETRY_DELAYS_MS.length - 1) await Bun.sleep(delay);
  }
  if (size === null) {
    d.logger.warn(
      { conversationId, chunkId: input.chunkId, signal: "chunk.missing_in_s3" },
      "uploaded chunk not found",
    );
    throw new BadRequestError("File not found in S3. Upload may have failed. Please try again.");
  }
  const tooSmall = size < MIN_AUDIO_BYTES;
  try {
    const chunk = await addChunk(d, {
      conversationId,
      timestamp: input.timestamp,
      source: input.source,
      fileUrl: input.fileUrl,
      // Marked in the same commit as the row, so the pipeline never spends a run on it.
      ...(tooSmall && { error: "Audio not playable" }),
    });
    if (tooSmall)
      d.logger.warn(
        { conversationId, size, signal: "chunk.upload_rejected" },
        "audio too small, marked unplayable",
      );
    return chunk;
  } catch (err) {
    if (
      err instanceof NotFoundError ||
      err instanceof ForbiddenError ||
      err instanceof ChunkError ||
      err instanceof BadRequestError
    )
      throw err;
    d.logger.error({ err }, "confirming an upload failed");
    throw new InternalError("Failed to confirm upload");
  }
}
