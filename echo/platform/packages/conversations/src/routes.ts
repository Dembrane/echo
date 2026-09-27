import type { Env } from "@echo/http";
import { Hono } from "hono";
import { bffConversationRoutes } from "./bff/routes";
import type { ConversationsDeps } from "./deps";
import { liveRoutes } from "./live/routes";
import { publicReportRoutes } from "./portal/reports";
import { portalRoutes } from "./portal/routes";
import { searchRoutes } from "./search/routes";
import { statelessRoutes } from "./stateless/routes";
import { conversationAudioRoutes } from "./v1/audio-routes";
import { conversationV1Routes } from "./v1/routes";

/**
 * Conversations, the participant portal and the audio pipeline's HTTP surface: v1
 * /api/participant and /api/conversations, the BFF conversation routes, live monitor
 * streams, stateless transcription and home search. Paths, bodies and error texts match
 * the Python API.
 */
export function conversationRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();
  // Live routes first: /api/conversations/health/stream must win over /:conversation_id.
  app.route("/", liveRoutes(d));
  app.route("/", portalRoutes(d));
  app.route("/", publicReportRoutes(d));
  app.route("/", conversationV1Routes(d));
  app.route("/", conversationAudioRoutes(d));
  app.route("/", bffConversationRoutes(d));
  app.route("/", statelessRoutes(d));
  app.route("/", searchRoutes(d));
  return app;
}
