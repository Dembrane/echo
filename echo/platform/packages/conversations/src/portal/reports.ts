import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the participant report routes land.
export function publicReportRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
