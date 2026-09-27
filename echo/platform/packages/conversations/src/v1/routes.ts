import type { Env } from "@echo/http";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";

// Placeholder until the v1 read and LLM routes land.
export function conversationV1Routes(_d: ConversationsDeps) {
  return new Hono<Env>();
}
