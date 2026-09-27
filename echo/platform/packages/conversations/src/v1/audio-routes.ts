import { AudioError } from "@echo/audio";
import { BadRequestError, NotFoundError, newId, PlatformError } from "@echo/core";
import { schema } from "@echo/db";
import { type Env, requireUser, type Signed } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { conversationForV1 } from "../access";
import type { ConversationsDeps } from "../deps";
import { InternalError } from "../errors";
import { liveServices } from "../live/routes";
import { type MergeDeps, mergeConversationAudio } from "../merge";
import { processChunk } from "../pipeline/defs";
import { conversationStore, transaction } from "../storage";

const { conversation, conversation_chunk, conversation_link, conversation_artifact } = schema;
const { model, required, optional, nullable, str, bool } = p;

// Presigned audio links the dashboard plays from: an hour, as get_signed_url signed them.
const SIGNED_URL_S = 3600;

const ContentQuery = {
  force_merge: optional(bool(), false),
  return_url: optional(bool(), false),
  signed: optional(bool(), true),
};
const ChunkContentQuery = { return_url: optional(bool(), false), signed: optional(bool(), true) };
const RetranscribeBody = model({
  new_conversation_name: required(str()),
  use_pii_redaction: optional(nullable(bool()), null),
  attach_verified_artifacts: optional(nullable(bool()), null),
});

/**
 * A merge a request waits for. The Python answered every merge failure with 400, a
 * transient one included; the pipeline retries those instead.
 */
async function mergeNow(d: MergeDeps, conversationId: string) {
  try {
    return await mergeConversationAudio(d, conversationId, newId());
  } catch (err) {
    if (err instanceof AudioError)
      throw new BadRequestError(`Failed to merge audio files: ${err.message}`);
    throw err;
  }
}

/**
 * The v1 conversation routes that touch audio: play (merge on demand), play one chunk,
 * retranscribe into a clone, and delete. Access is the v1 check: staff pass on existence,
 * others need conversation:read and the route's policy.
 */
export function conversationAudioRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();

  /** return_url_or_redirect: the stored path, a signed link, or a redirect to it. */
  const deliver = (url: string, signed: boolean, returnUrl: boolean) => {
    const link = d.audio.presignDownload(d.audioUrls.keyOf(url), {
      expiresInSeconds: SIGNED_URL_S,
    });
    if (returnUrl) return { url: signed ? link : url };
    return { redirect: link };
  };

  app.get("/api/conversations/:conversation_id/content", async (c) => {
    const who = requireUser(c);
    const cid = c.req.param("conversation_id");
    await conversationForV1(d, who, cid);
    const { query } = await p.validate(c.req, { query: ContentQuery });
    const store = conversationStore(d.db);
    const chunks = await store.chunks(cid, 1000);
    if (!chunks.length) throw new NotFoundError("Conversation not found");
    const conv = await store.conversationIncludingDeleted(cid);
    if (!conv) throw new NotFoundError("Conversation not found");
    let path = conv.merged_audio_path;
    if (query.force_merge || !path?.startsWith("http")) {
      // Merging here keeps the Python contract (the first play builds the file); the
      // ffmpeg work runs on the media service, the API only waits for it.
      path = (await mergeNow(d, cid)).path;
    }
    const out = deliver(path, query.signed, query.return_url);
    return out.redirect ? c.redirect(out.redirect, 307) : c.json(out.url);
  });

  app.get("/api/conversations/:conversation_id/chunks/:chunk_id/content", async (c) => {
    const who = requireUser(c);
    const cid = c.req.param("conversation_id");
    await conversationForV1(d, who, cid);
    const { query } = await p.validate(c.req, { query: ChunkContentQuery });
    const chunk = await conversationStore(d.db).chunk(c.req.param("chunk_id"));
    if (!chunk || chunk.conversation_id !== cid) throw new NotFoundError("Conversation not found");
    if (!chunk.path) throw new NotFoundError("No content found");
    if (!chunk.path.startsWith("http"))
      throw new BadRequestError("File is not valid (URL type not implemented)");
    const out = deliver(chunk.path, query.signed, query.return_url);
    return out.redirect ? c.redirect(out.redirect, 307) : c.json(out.url);
  });

  app.post("/api/conversations/:conversation_id/retranscribe", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: RetranscribeBody });
    return c.json(await retranscribe(d, who, c.req.param("conversation_id"), body.data));
  });

  app.delete("/api/conversations/:conversation_id", async (c) => {
    const who = requireUser(c);
    const cid = c.req.param("conversation_id");
    const { conversation: conv } = await conversationForV1(d, who, cid, "conversation:delete");
    try {
      const now = d.now().toISOString();
      // Soft delete: audio stays for the grace period; every read filters deleted_at.
      await d.db
        .update(conversation)
        .set({ deleted_at: now, updated_at: now })
        .where(eq(conversation.id, cid));
    } catch (err) {
      throw new InternalError(`Failed to delete conversation: ${(err as Error).message}`);
    }
    // A deleted conversation stops counting as a live recording.
    await liveServices(d).meter.meter(conv.project_id, cid, "close", d.now());
    return c.json({ status: "success", message: "Conversation deleted successfully" });
  });

  return app;
}

/**
 * retranscribe_conversation: merge the original's audio, clone the conversation around
 * it (finished, one chunk) and run the chunk pipeline on the clone. The Python answered
 * every failure, access refusals included, with 200 and an error body; the dashboard
 * reads that body, so the contract is kept.
 */
async function retranscribe(
  d: ConversationsDeps,
  who: Signed,
  conversationId: string,
  body: {
    new_conversation_name: string;
    use_pii_redaction: boolean | null;
    attach_verified_artifacts: boolean | null;
  },
) {
  try {
    await conversationForV1(d, who, conversationId, "project:update");
    const store = conversationStore(d.db);
    const original = await store.conversationIncludingDeleted(conversationId);
    if (!original) throw new NotFoundError("Conversation not found");
    let pii = body.use_pii_redaction;
    if (pii === null)
      pii = Boolean((await store.project(original.project_id))?.anonymize_transcripts);

    const chunks = await store.chunks(conversationId, 1000);
    if (!chunks.length) throw new NotFoundError("Conversation not found");
    const { path: merged, duration } = await mergeNow(d, conversationId);

    const newConversationId = newId();
    const chunkId = newId();
    const now = d.now().toISOString();
    await transaction(d.db, async (tx) => {
      await tx.db.insert(conversation).values({
        id: newConversationId,
        duration,
        source: "CLONE",
        project_id: original.project_id,
        participant_name: body.new_conversation_name
          ? body.new_conversation_name
          : `${requireName(original.participant_name)} (retranscribed)`,
        participant_email: original.participant_email || null,
        participant_user_agent: original.participant_user_agent || null,
        merged_audio_path: merged,
        is_anonymized: pii,
        // Complete at creation (one chunk, nothing more coming): the chunk run finalizes it.
        is_finished: true,
        created_at: now,
        updated_at: now,
      });
      await tx.db.insert(conversation_link).values({
        source_conversation_id: conversationId,
        target_conversation_id: newConversationId,
        link_type: "CLONE",
        date_created: now,
      });
      if (body.attach_verified_artifacts) {
        const artifacts = await tx.db
          .select()
          .from(conversation_artifact)
          .where(
            and(
              eq(conversation_artifact.conversation_id, conversationId),
              isNotNull(conversation_artifact.approved_at),
            ),
          );
        for (const a of artifacts)
          await tx.db.insert(conversation_artifact).values({
            id: newId(),
            conversation_id: newConversationId,
            key: a.key,
            topic_label: a.topic_label,
            content: a.content,
            approved_at: a.approved_at,
            read_aloud_stream_url: a.read_aloud_stream_url || "",
            date_created: now,
          });
      }
      await tx.db.insert(conversation_chunk).values({
        id: chunkId,
        conversation_id: newConversationId,
        timestamp: now,
        path: merged,
        source: "CLONE",
        created_at: now,
        updated_at: now,
      });
      await d.jobs.enqueue(
        processChunk,
        { chunkId, usePiiRedaction: pii ?? false },
        { tx: tx.sql, workflowId: `conversations.chunk:${chunkId}` },
      );
    });
    return {
      status: "success",
      message: "Retranscription in progress",
      new_conversation_id: newConversationId,
    };
  } catch (err) {
    if (err instanceof PlatformError && err.status < 500) {
      const detail = typeof err.details === "object" && err.details ? err.details : err.message;
      return { status: "error", message: "Operation failed", error_detail: detail };
    }
    d.logger.error({ err }, "retranscribe failed");
    return {
      status: "error",
      message: "Failed to retranscribe conversation",
      error_detail: "internal error",
    };
  }
}

/** The Python concatenated a missing name and failed; kept as a failure. */
function requireName(name: string | null): string {
  if (name === null) throw new TypeError("unsupported operand type(s) for +: 'NoneType' and 'str'");
  return name;
}
