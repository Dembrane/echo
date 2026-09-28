import { ForbiddenError, NotFoundError } from "@dembrane/core";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { TOO_MANY } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { conversationForV1 } from "../access";
import type { ConversationsDeps } from "../deps";
import { PARTICIPANT_TOKEN_HEADER } from "../participant-token";
import { conversationStore } from "../storage";
import { replyProtocol, withStatus } from "./reply";
import { v1Store } from "./storage";
import { conversationTranscript, generateTitleAndStore, summarizeAndStore } from "./summary";
import { computeTokenCount } from "./token-count";

const { model, required, str } = p;

/** Replies spend a model call each; this stops a loop, not a participant (H-10). */
const REPLY_LIMIT = { name: "participant_get_reply", capacity: 20, windowSeconds: 60 } as const;

const SSE_HEADERS = {
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  "X-Accel-Buffering": "no",
};

/**
 * v1 /api/conversations reads and model-backed actions: chunk counts, transcript,
 * captured emails, token count, summary and title generation (hosts), and the portal's
 * streamed reply. Access is raise_if_conversation_not_found_or_not_authorized: staff
 * need only an existing conversation, everyone else conversation:read plus the route's
 * policy.
 */
export function conversationV1Routes(d: ConversationsDeps) {
  const app = new Hono<Env>();

  app.get("/api/conversations/:conversation_id/counts", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id);
    let error = 0;
    let pending = 0;
    let ok = 0;
    for (const chunk of await v1Store(d.db).chunkStates(id)) {
      if (chunk.error !== null) error++;
      else if (chunk.transcript !== null) ok++;
      else pending++;
    }
    return c.json({ total: error + ok + pending, processed: error + ok, error, pending, ok });
  });

  app.get("/api/conversations/:conversation_id/transcript", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id);
    return c.json(await conversationTranscript(v1Store(d.db), id));
  });

  app.get("/api/conversations/:conversation_id/emails", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id);
    const emails = await v1Store(d.db).emails(id);
    return c.json({ emails_csv: emails.join(","), count: emails.length });
  });

  app.get("/api/conversations/:conversation_id/token-count", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id);
    return c.json(await computeTokenCount(d, id, d.now));
  });

  app.post("/api/conversations/:conversation_id/summarize", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id, "project:update");
    return c.json(await summarizeAndStore(d, id));
  });

  app.post("/api/conversations/:conversation_id/generate-title", async (c) => {
    const who = requireUser(c);
    const id = c.req.param("conversation_id");
    await conversationForV1(d, who, id, "project:update");
    return c.json(await generateTitleAndStore(d, id));
  });

  // Participant route: no session. The conversation must exist, not be deleted and be
  // open, the participant token must match when sent (Q7), and a per-conversation
  // ceiling applies (H-10); the Python checked none of these and streamed an error
  // for a missing conversation.
  app.post("/api/conversations/:conversation_id/get-reply", async (c) => {
    const id = c.req.param("conversation_id");
    const { body } = await p.validate(c.req, { body: model({ language: required(str()) }) });
    const store = conversationStore(d.db);
    const conv = await store.conversation(id);
    if (!conv) throw new NotFoundError("Conversation not found");
    d.tokens.check(c.req.header(PARTICIPANT_TOKEN_HEADER), id, conv.project_id);
    const project = await store.project(conv.project_id);
    if (!project) throw new NotFoundError("Conversation not found");
    if (!project.is_conversation_allowed)
      throw new ForbiddenError("Conversation not open for participation");
    if (!(await d.limiter.allow(REPLY_LIMIT, id))) {
      return c.json({ detail: TOO_MANY }, 429);
    }
    const lines = withStatus(replyProtocol(d, id, body.data.language));
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const next = await lines.next();
        if (next.done) ctrl.close();
        else ctrl.enqueue(new TextEncoder().encode(next.value));
      },
      async cancel() {
        await lines.return(undefined);
      },
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  });

  return app;
}
