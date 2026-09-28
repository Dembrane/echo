import { chatsStorage, generateTitle } from "@dembrane/chats";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";
import * as runs from "./service";
import { liveEventStream, pollingEventStream } from "./sse";
import { runsStorage } from "./storage";

const { model, required, optional, nullable, str, int } = p;

const createBody = model({
  project_id: required(str({ min: 1 })),
  project_chat_id: optional(nullable(str()), null),
  message: required(str({ min: 1, max: runs.MAX_AGENTIC_MESSAGE_LENGTH })),
  language: optional(str({ min: 1 }), "en"),
});
const appendBody = model({
  message: required(str({ min: 1, max: runs.MAX_AGENTIC_MESSAGE_LENGTH })),
  language: optional(str({ min: 1 }), "en"),
});
const afterSeq = { after_seq: optional(int({ ge: 0 }), 0) };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Agentic runs: create, follow-up messages, the event stream that also starts a queued
 * turn, stop, reads and the event log. Turns run in the worker; these routes only write
 * the host's side and read what the turn wrote.
 */
export function runRoutes(deps: AgenticRoutesDeps) {
  const store = runsStorage(deps.db);
  const chats = chatsStorage(deps.db);
  const now = deps.now ?? (() => new Date());
  const d: runs.RunsDeps = {
    store,
    chats,
    access: deps.access,
    queue: deps.queue,
    logger: deps.logger,
    now,
    generateTitle: (text, language) => generateTitle(deps.models, text, language),
  };
  const stream = {
    store,
    logger: deps.logger,
    heartbeatMs: deps.config.agentic.sseHeartbeatSeconds * 1000,
  };
  const app = new Hono<Env>();

  app.post("/api/agentic/runs", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: createBody });
    return c.json(await runs.createRun(d, who, body.data), 201);
  });

  app.post("/api/agentic/runs/:run_id/messages", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: appendBody });
    return c.json(await runs.appendMessage(d, who, c.req.param("run_id"), body.data));
  });

  app.post("/api/agentic/runs/:run_id/stream", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: afterSeq });
    const runId = c.req.param("run_id");
    await runs.claimTurn(d, who, runId);
    return new Response(liveEventStream(stream, runId, query.after_seq, c.req.raw.signal), {
      headers: { ...SSE_HEADERS, "X-Accel-Buffering": "no" },
    });
  });

  app.post("/api/agentic/runs/:run_id/stop", async (c) => {
    const who = requireUser(c);
    return c.json(await runs.stopRun(d, who, c.req.param("run_id")));
  });

  app.get("/api/agentic/runs/:run_id", async (c) => {
    const who = requireUser(c);
    return c.json(await runs.getRun(d, who, c.req.param("run_id")));
  });

  app.get("/api/agentic/chats/:project_chat_id/latest-run", async (c) => {
    const who = requireUser(c);
    return c.json(await runs.latestChatRun(d, who, c.req.param("project_chat_id")));
  });

  app.get("/api/agentic/runs/:run_id/events", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: afterSeq });
    const runId = c.req.param("run_id");
    if ((c.req.header("accept") ?? "").includes("text/event-stream")) {
      await runs.authorizedRun(d, who, runId);
      return new Response(pollingEventStream(stream, runId, query.after_seq, c.req.raw.signal), {
        headers: SSE_HEADERS,
      });
    }
    return c.json(await runs.runEvents(d, who, runId, query.after_seq));
  });

  return app;
}
