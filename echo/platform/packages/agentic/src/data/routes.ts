import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";

export function dataRoutes(_deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}

export function memoryBffRoutes(_deps: AgenticRoutesDeps) {
  const app = new Hono<Env>();
  return app;
}
