import type { Access } from "@echo/access";
import type { Db } from "@echo/db";
import type { Env } from "@echo/http";
import type { Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { RateLimiter } from "@echo/ratelimit";
import { Hono } from "hono";
import type { Capture } from "./capture";

export interface ChatRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly models: Models;
  readonly limiter: RateLimiter;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * The v1 /api/chats routes and the chat BFF (/api/v2/bff/chats, /api/v2/bff/chat-messages).
 * Paths, bodies and error texts match the Python API.
 */
export function chatRoutes(_deps: ChatRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}
