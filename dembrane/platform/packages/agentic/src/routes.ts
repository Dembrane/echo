import type { Access } from "@dembrane/access";
import type { Capture } from "@dembrane/analytics";
import type { Config } from "@dembrane/config";
import type { Db } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { Queue } from "@dembrane/queue";
import { Hono } from "hono";
import { canvasRoutes } from "./canvas/routes";
import { dataRoutes, memoryBffRoutes } from "./data/routes";
import { runRoutes } from "./runs/routes";

export interface AgenticRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly models: Models;
  readonly queue: Pick<Queue, "enqueue">;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly config: Pick<Config, "agentic" | "canvas" | "http">;
  readonly now?: () => Date;
}

/**
 * /api/agentic (runs, their event streams, and the reads and writes the assistant uses)
 * and the memory BFF (/api/v2/bff/memory). Paths, bodies and error texts match the
 * Python API.
 */
export function agenticRoutes(deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  app.route("/", runRoutes(deps));
  app.route("/", dataRoutes(deps));
  app.route("/", canvasRoutes(deps));
  app.route("/", memoryBffRoutes(deps));
  return app;
}
