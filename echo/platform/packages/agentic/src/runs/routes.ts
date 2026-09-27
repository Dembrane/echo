import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";

export function runRoutes(_deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}
