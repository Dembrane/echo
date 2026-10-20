import { giveBack } from "@dembrane/allowance";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  newId,
  PaymentRequiredError,
  StatusError,
} from "@dembrane/core";
import { ChunkError } from "../chunks";
import type { ConversationsDeps } from "../deps";
import {
  type AudioRefusal,
  hasAudioChunk,
  LIVE_SOURCE,
  liveChunkCheck,
  requireAudioStart,
  reserveUpload,
} from "../free-audio";
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
  if (!conv) throw new NotFoundError("conversation.not_found");
  const project = await store.project(conv.project_id);
  // project_service raised ProjectNotFoundException, which these routes turned into 500s.
  if (!project) throw new Error(`project ${conv.project_id} not found`);
  return { conv, open: project.is_conversation_allowed === true };
}

/** check-s3: a presigned PUT the portal tries before recording, to learn the bucket is reachable. */
export async function probeUrl(d: ConversationsDeps, conversationId: string): Promise<string> {
  const { open } = await openConversation(d, conversationId);
  if (!open) throw new ForbiddenError("conversation.not_open");
  try {
    return d.audio.presignUpload(`conversation/${conversationId}/probe`, {
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
  } catch (err) {
    d.logger.error({ err }, "presigning the S3 probe failed");
    throw new StatusError(500, "upload.probe_url_failed");
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
      throw new StatusError(500, "upload.url_failed");
    }
    const { conv, open } = await openConversation(d, conversationId);
    if (!open) throw new StatusError(500, "upload.url_failed");
    // A conversation's first audio starts a recording; uploads always do.
    const live = conv.source === "PORTAL_TEXT" || conv.source === LIVE_SOURCE;
    if (live && (await hasAudioChunk(d.db, conversationId))) await liveChunkCheck(d, conv);
    else await requireAudioStart(d, conv.project_id);
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
    if (err instanceof NotFoundError || err instanceof PaymentRequiredError) throw err;
    if (!(err instanceof StatusError)) d.logger.error({ err }, "generating an upload URL failed");
    throw new StatusError(500, "upload.url_failed");
  }
}

/**
 * confirm-upload: the portal uploaded to the presigned form; check the object exists and
 * create the chunk. H-7: the Python accepted any key, so another conversation's audio
 * could be transcribed into this one and read back; the key must be the one issued for
 * this conversation and chunk. A live chunk also carries the free limit's stop signal.
 */
export async function confirmUpload(
  d: ConversationsDeps,
  conversationId: string,
  input: { chunkId: string; fileUrl: string; timestamp: Date; source: string },
): Promise<{ chunk: Awaited<ReturnType<typeof addChunk>>; recordingStop: AudioRefusal | null }> {
  let key: string;
  try {
    key = d.audioUrls.keyOf(input.fileUrl);
  } catch (err) {
    d.logger.error({ err }, "confirm-upload got an unusable file_url");
    throw new StatusError(500, "upload.confirm_failed");
  }
  if (!key.startsWith(`conversation/${conversationId}/chunks/${input.chunkId}-`))
    throw new BadRequestError("upload.wrong_conversation");

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
    throw new BadRequestError("upload.failed", {
      message: "File not found in S3. Upload may have failed. Please try again.",
    });
  }
  const tooSmall = size < MIN_AUDIO_BYTES;
  // An upload is measured and its seconds reserved before anything transcribes it.
  let reservation: Awaited<ReturnType<typeof reserveUpload>> = null;
  let recordingStop: AudioRefusal | null = null;
  if (input.source === LIVE_SOURCE) recordingStop = await checkLiveChunk(d, conversationId, key);
  else if (!tooSmall) {
    const conv = await conversationStore(d.db).conversation(conversationId);
    if (!conv) throw new NotFoundError("conversation.not_found");
    reservation = await reserveUpload(d, conv, key, size);
  }
  try {
    const chunk = await addChunk(d, {
      conversationId,
      timestamp: input.timestamp,
      source: input.source,
      fileUrl: input.fileUrl,
      ...(reservation && { audioSeconds: reservation.seconds }),
      // Marked in the same commit as the row, so the pipeline never spends a run on it.
      ...(tooSmall && { error: "Audio not playable" }),
    });
    if (tooSmall)
      d.logger.warn(
        { conversationId, size, signal: "chunk.upload_rejected" },
        "audio too small, marked unplayable",
      );
    return { chunk, recordingStop };
  } catch (err) {
    if (reservation)
      await giveBack(d.db, reservation.a, "audio_seconds", reservation.reserved).catch((e) =>
        d.logger.error({ err: e, conversationId }, "giving back an upload reservation failed"),
      );
    if (
      err instanceof NotFoundError ||
      err instanceof ForbiddenError ||
      err instanceof ChunkError ||
      err instanceof BadRequestError
    )
      throw err;
    d.logger.error({ err }, "confirming an upload failed");
    throw new StatusError(500, "upload.confirm_failed");
  }
}

// A refused live chunk is deleted; a failed read of the conversation lets it through.
async function checkLiveChunk(
  d: ConversationsDeps,
  conversationId: string,
  key: string,
): Promise<AudioRefusal | null> {
  const conv = await conversationStore(d.db)
    .conversation(conversationId)
    .catch((err) => {
      d.logger.error(
        { err, conversationId, signal: "free_audio.live_check_failed" },
        "live chunk limit check failed",
      );
      return null;
    });
  if (!conv) return null;
  try {
    return await liveChunkCheck(d, conv);
  } catch (err) {
    await d.audio
      .delete(key)
      .catch((e) =>
        d.logger.error({ err: e, key, conversationId }, "deleting a refused chunk failed"),
      );
    throw err;
  }
}
