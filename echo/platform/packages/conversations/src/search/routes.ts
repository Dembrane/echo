import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until home search land.
export function searchRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
