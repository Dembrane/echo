import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the v1 audio, retranscribe and delete routes land.
export function conversationAudioRoutes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
