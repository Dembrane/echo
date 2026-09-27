import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the BFF conversation routes land.
export function bffConversationRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
