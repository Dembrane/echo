import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the portal core routes land.
export function portalRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
