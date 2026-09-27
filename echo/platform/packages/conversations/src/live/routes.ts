import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the pings, live, monitor and health stream routes land.
export function liveRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
