import type { Env } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";
import { liveServices } from "../live/routes";
import { PARTICIPANT_TOKEN_HEADER } from "../participant-token";
import { conversationStore } from "../storage";
import {
  addChunk,
  initiate,
  participantChunks,
  participantConversation,
  participantReplies,
  publicChunk,
  publicConversation,
  publicProject,
  removeChunk,
  requestFinish,
} from "./service";
import { confirmUpload, probeUrl, uploadUrl } from "./uploads";

const { model, optional, required, nullable, str, list, datetime } = p;

const InitiateBody = model({
  name: required(str()),
  pin: required(str()),
  conversation_id: optional(nullable(str()), null),
  email: optional(nullable(str()), null),
  user_agent: optional(nullable(str()), null),
  tag_id_list: optional(nullable(list(str())), [] as string[]),
  source: optional(nullable(str()), null),
  visitor_id: optional(nullable(str()), null),
});

const UploadTextBody = model({
  timestamp: required(datetime()),
  content: required(str()),
  source: optional(nullable(str()), "PORTAL_TEXT"),
});

const UploadUrlBody = model({
  filename: required(str()),
  content_type: required(str()),
  conversation_id: required(str()),
});

const ConfirmBody = model({
  chunk_id: required(str()),
  file_url: required(str()),
  timestamp: required(datetime()),
  source: optional(str(), "PORTAL_AUDIO"),
});

/**
 * The participant portal (dembrane/api/participant.py): starting a conversation, its
 * project page, uploads (presigned, direct and typed) and the finish signal. No session:
 * the portal proves itself with the participant token from initiate, or during the
 * transition with the conversation id alone.
 */
export function portalRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();
  const token = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header(PARTICIPANT_TOKEN_HEADER);

  app.post("/api/participant/projects/:project_id/conversations/initiate", async (c) => {
    const { body } = await p.validate(c.req, { body: InitiateBody });
    const b = body.data;
    const projectId = c.req.param("project_id");
    const out = await initiate(d, projectId, {
      name: b.name,
      email: b.email,
      userAgent: b.user_agent,
      tagIds: b.tag_id_list ?? [],
      source: b.source,
    });
    const live = liveServices(d);
    // The funnel dot this conversation grew out of leaves the monitor's lanes at once.
    await live.presence
      .linkVisitorConversation(b.visitor_id, out.conversation.id, d.now())
      .catch(() => {});
    // After the response, as the Python's background task: metering never slows a start.
    if (b.source !== "PORTAL_TEXT")
      setTimeout(() => void live.meter.meter(projectId, out.conversation.id, "open", d.now()), 0);
    // Issued here and kept by the portal; the body stays what the portal already reads.
    c.header(PARTICIPANT_TOKEN_HEADER, out.token);
    return c.json(publicConversation(out.conversation));
  });

  app.get("/api/participant/projects/:project_id", async (c) =>
    c.json(await publicProject(d, c.req.param("project_id"))),
  );

  app.get("/api/participant/projects/:project_id/conversations/:conversation_id", async (c) => {
    const [pid, cid] = [c.req.param("project_id"), c.req.param("conversation_id")];
    d.tokens.check(token(c), cid, pid);
    return c.json(await participantConversation(d, pid, cid));
  });

  app.get(
    "/api/participant/projects/:project_id/conversations/:conversation_id/chunks",
    async (c) => {
      const [pid, cid] = [c.req.param("project_id"), c.req.param("conversation_id")];
      d.tokens.check(token(c), cid, pid);
      return c.json(await participantChunks(d, pid, cid));
    },
  );

  app.get(
    "/api/participant/projects/:project_id/conversations/:conversation_id/replies",
    async (c) => {
      const [pid, cid] = [c.req.param("project_id"), c.req.param("conversation_id")];
      d.tokens.check(token(c), cid, pid);
      return c.json(await participantReplies(d, pid, cid));
    },
  );

  app.delete(
    "/api/participant/projects/:project_id/conversations/:conversation_id/chunks/:chunk_id",
    async (c) => {
      const [pid, cid] = [c.req.param("project_id"), c.req.param("conversation_id")];
      d.tokens.check(token(c), cid, pid);
      await removeChunk(d, pid, cid, c.req.param("chunk_id"));
      return c.json(null);
    },
  );

  app.post("/api/participant/conversations/:conversation_id/upload-text", async (c) => {
    const cid = c.req.param("conversation_id");
    d.tokens.check(token(c), cid);
    const { body } = await p.validate(c.req, { body: UploadTextBody });
    const chunk = await addChunk(d, {
      conversationId: cid,
      timestamp: body.data.timestamp,
      transcript: body.data.content,
      source: body.data.source || "PORTAL_TEXT",
    });
    return c.json(publicChunk(chunk));
  });

  app.post("/api/participant/conversations/:conversation_id/check-s3", async (c) => {
    const cid = c.req.param("conversation_id");
    d.tokens.check(token(c), cid);
    return c.json({ probe_url: await probeUrl(d, cid) });
  });

  app.post("/api/participant/conversations/:conversation_id/get-upload-url", async (c) => {
    const cid = c.req.param("conversation_id");
    d.tokens.check(token(c), cid);
    const { body } = await p.validate(c.req, { body: UploadUrlBody });
    return c.json(await uploadUrl(d, cid, body.data.filename, body.data.content_type));
  });

  app.post("/api/participant/conversations/:conversation_id/confirm-upload", async (c) => {
    const cid = c.req.param("conversation_id");
    d.tokens.check(token(c), cid);
    const { body } = await p.validate(c.req, { body: ConfirmBody });
    const chunk = await confirmUpload(d, cid, {
      chunkId: body.data.chunk_id,
      fileUrl: body.data.file_url,
      timestamp: body.data.timestamp,
      source: body.data.source,
    });
    await liveServices(d).meter.meterUpload(cid, d.now());
    return c.json(publicChunk(chunk));
  });

  app.post("/api/participant/conversations/:conversation_id/finish", async (c) => {
    const cid = c.req.param("conversation_id");
    d.tokens.check(token(c), cid);
    await requestFinish(d, cid);
    // The recording stops counting against concurrent recordings.
    const conv = await conversationStore(d.db)
      .conversation(cid)
      .catch(() => null);
    if (conv) await liveServices(d).meter.meter(conv.project_id, cid, "close", d.now());
    return c.json("OK");
  });

  return app;
}
