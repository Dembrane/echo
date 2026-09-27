import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until stateless transcription land.
export function statelessRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
