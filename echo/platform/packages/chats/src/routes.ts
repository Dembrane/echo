import type { Access } from "@echo/access";
import type { Capture } from "@echo/analytics";
import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import type { Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { RateLimiter } from "@echo/ratelimit";
import { Hono } from "hono";
import * as bff from "./bff";
import { chatReads } from "./conversations";
import type { ChatDeps } from "./deps";
import { reply } from "./reply";
import * as chats from "./service";
import { chatsStorage } from "./storage";

export interface ChatRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly models: Pick<Models, "model">;
  readonly limiter: Pick<RateLimiter, "check">;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Seconds before a silent reply tells the dashboard the system is busy (20 in production). */
  readonly highLoadDelayMs?: number;
}

const { model, nested, optional, required, nullable, str, int, bool, literal, list } = p;

export function chatDeps(deps: ChatRoutesDeps): ChatDeps {
  return {
    store: chatsStorage(deps.db),
    reads: chatReads(deps.db),
    access: deps.access,
    models: deps.models,
    limiter: deps.limiter,
    capture: deps.capture,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    newId,
    highLoadDelayMs: deps.highLoadDelayMs ?? 20_000,
    suggestionCache: new Map(),
  };
}

const optStr = optional(nullable(str()), null);
const optStrList = optional(nullable(list(str())), null);

/**
 * The v1 /api/chats routes and the chat BFF (/api/v2/bff/chats, /api/v2/bff/chat-messages).
 * Paths, bodies and error texts match the Python API.
 */
export function chatRoutes(deps: ChatRoutesDeps) {
  const d = chatDeps(deps);
  const app = new Hono<Env>();

  // ── v1 /api/chats ─────────────────────────────────────────────────

  app.delete("/api/chats/:chat_id", async (c) => {
    const who = requireUser(c);
    return c.json(await chats.deleteChat(d, who, c.req.param("chat_id")));
  });

  app.get("/api/chats/:chat_id/context", async (c) => {
    const who = requireUser(c);
    return c.json(await chats.getContext(d, who, c.req.param("chat_id")));
  });

  app.post("/api/chats/:chat_id/add-context", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        conversation_id: optStr,
        conversation_ids: optStrList,
        select_all: optional(nullable(bool()), null),
        project_id: optStr,
        tag_ids: optStrList,
        verified_only: optional(nullable(bool()), null),
        search_text: optStr,
      }),
    });
    return c.json(await chats.addContext(d, who, c.req.param("chat_id"), body.data));
  });

  app.post("/api/chats/:chat_id/delete-context", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ conversation_id: required(str()) }),
    });
    return c.json(
      await chats.deleteContext(d, who, c.req.param("chat_id"), body.data.conversation_id),
    );
  });

  app.post("/api/chats/:chat_id/lock-conversations", async (c) => {
    const who = requireUser(c);
    return c.json(await chats.lockConversations(d, who, c.req.param("chat_id")));
  });

  app.get("/api/chats/:chat_id/suggestions", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: { language: optional(str(), "en") } });
    return c.json(await chats.suggestions(d, who, c.req.param("chat_id"), query.language));
  });

  app.post("/api/chats/:chat_id/initialize-mode", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        mode: required(literal("overview", "deep_dive", "agentic")),
        project_id: required(str()),
      }),
    });
    return c.json(await chats.initializeMode(d, who, c.req.param("chat_id"), body.data));
  });

  app.post("/api/chats/:chat_id", async (c) => {
    const who = requireUser(c);
    const { query, body } = await p.validate(c.req, {
      query: { protocol: optional(str(), "data"), language: optional(str(), "en") },
      body: model({
        messages: required(
          list(
            nested(
              model({
                role: required(literal("user", "assistant", "dembrane")),
                content: required(str()),
              }),
            ),
          ),
        ),
        template_key: optStr,
      }),
    });
    return reply(d, who, c.req.param("chat_id"), body.data, query.protocol, query.language);
  });

  // ── /api/v2/bff/chats ─────────────────────────────────────────────

  app.post("/api/v2/bff/chats", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ project_id: required(str()), name: optStr }),
    });
    return c.json(await bff.createChat(d, who, body.data));
  });

  app.get("/api/v2/bff/chats", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        project_id: required(str()),
        limit: optional(int({ ge: 1, le: 200 }), 15),
        offset: optional(int({ ge: 0 }), 0),
        has_messages: optional(bool(), false),
        q: optional(nullable(str({ max: 200 })), null),
      },
    });
    return c.json(await bff.listChats(d, who, query));
  });

  app.get("/api/v2/bff/chats/:chat_id", async (c) => {
    const who = requireUser(c);
    return c.json(await bff.getChat(d, who, c.req.param("chat_id")));
  });

  app.patch("/api/v2/bff/chats/:chat_id", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ name: optStr, chat_mode: optStr }),
    });
    return c.json(await bff.updateChat(d, who, c.req.param("chat_id"), body.data));
  });

  // ── /api/v2/bff/chat-messages ─────────────────────────────────────

  app.get("/api/v2/bff/chat-messages", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { chat_id: required(str()), limit: optional(int({ ge: 1, le: 500 }), 100) },
    });
    return c.json(await bff.listMessages(d, who, query.chat_id, query.limit));
  });

  app.post("/api/v2/bff/chat-messages", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        project_chat_id: required(str()),
        message_from: required(str()),
        text: required(str()),
        template_key: optStr,
      }),
    });
    return c.json(await bff.createMessage(d, who, body.data));
  });

  return app;
}
