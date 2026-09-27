import type { Access } from "@echo/access";
import type { Capture } from "@echo/chats";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Env } from "@echo/http";
import type { Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { Queue } from "@echo/queue";
import { Hono } from "hono";

export interface AgenticRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly models: Models;
  readonly queue: Pick<Queue, "enqueue">;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly config: Pick<Config, "agentic" | "http">;
  readonly now?: () => Date;
}

/**
 * /api/agentic (runs, their event streams, and the reads and writes the assistant uses)
 * and the memory BFF (/api/v2/bff/memory). Paths, bodies and error texts match the
 * Python API.
 */
export function agenticRoutes(_deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}
