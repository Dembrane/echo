import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";

export function canvasRoutes(_deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}
