import { DrizzleAccessStore } from "@echo/access";
import { accountRoutes } from "@echo/account";
import { analysisRoutes } from "@echo/analysis";
import { billingRoutes, mollieWebhookRoutes } from "@echo/billing";
import { canvasRoutes } from "@echo/canvas";
import {
  AudioUrls,
  type ConversationsDeps,
  conversationRoutes,
  PARTICIPANT_TOKEN_HEADER,
  ParticipantTokens,
} from "@echo/conversations";
import { reportRoutes as feedbackReportRoutes, responseRoutes } from "@echo/feedback";
import { vertexCompleter, vertexEmbedder } from "@echo/llm";
import { mapRoutes } from "@echo/map";
import { notificationRoutes } from "@echo/notifications";
import { pricingRoutes } from "@echo/pricing";
import { projectRoutes } from "@echo/projects";
import { reportRoutes } from "@echo/reports";
import { staffRoutes } from "@echo/staff";
import { statsRoutes } from "@echo/stats";
import { FilesystemStorage, localStorageHandler } from "@echo/storage";
import { queueSink, tenancyRoutes } from "@echo/tenancy";
import { trainingRoutes } from "@echo/training";
import { verifyRoutes } from "@echo/verify";
import { webhookRoutes } from "@echo/webhooks";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Deps, Env } from "./deps";
import { correlation } from "./middleware/correlation";
import { notFound, onError } from "./middleware/errors";
import { session } from "./middleware/session";
import { systemRoutes } from "./routes/system";

/** Pure composition: no I/O at build time, so tests call app.request() with fake deps. */
export function buildApp(deps: Deps) {
  const app = new Hono<Env>();
  app.use(correlation(deps));
  app.use(secureHeaders());
  app.use(
    "/api/*",
    cors({
      origin: [deps.config.http.dashboardUrl, deps.config.http.portalUrl],
      credentials: true,
      // The portal reads its participant token from initiate's response.
      exposeHeaders: ["x-request-id", PARTICIPANT_TOKEN_HEADER],
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.use("/api/*", session(deps));
  app.route("/", systemRoutes(deps));
  app.route("/", accountRoutes(deps));
  app.route("/", projectRoutes(deps));
  app.route(
    "/",
    webhookRoutes({
      ...deps,
      deliver: deps.deliverWebhook,
      allowPrivateTargets: deps.config.webhooks.allowPrivateTargets,
      dashboardUrl: deps.config.http.dashboardUrl,
    }),
  );
  app.route("/", notificationRoutes(deps));
  app.route("/", reportRoutes(deps));
  app.route(
    "/",
    analysisRoutes({
      ...deps,
      jobs: deps.queue,
      completer: vertexCompleter(deps.models, {
        groups: {
          text_fast: deps.config.llm.textFast,
          multi_modal_fast: deps.config.llm.multiModalFast,
          multi_modal_pro: deps.config.llm.multiModalPro,
        },
      }),
      embedder: vertexEmbedder(deps.models, {
        project: deps.config.llm.vertexProject,
        location: deps.config.llm.embeddingLocation,
        model: deps.config.llm.embeddingModel,
      }),
      enablePresent: deps.config.analysis.enablePresent,
      embeddingModel: deps.config.llm.embeddingModel,
      embeddingLocation: deps.config.llm.embeddingLocation,
    }),
  );
  app.route(
    "/",
    mapRoutes({
      ...deps,
      jobs: deps.queue,
      completer: vertexCompleter(deps.models, {
        groups: {
          text_fast: deps.config.llm.textFast,
          multi_modal_fast: deps.config.llm.multiModalFast,
          multi_modal_pro: deps.config.llm.multiModalPro,
        },
      }),
      embedder: vertexEmbedder(deps.models, {
        project: deps.config.llm.vertexProject,
        location: deps.config.llm.embeddingLocation,
        model: deps.config.llm.embeddingModel,
      }),
      embeddingModel: deps.config.llm.embeddingModel,
      embeddingLocation: deps.config.llm.embeddingLocation,
      nodeLimitCeiling: deps.config.analysis.nodeLimitCeiling ?? null,
      edgeLimitCeiling: deps.config.analysis.edgeLimitCeiling ?? null,
    }),
  );
  app.route(
    "/",
    canvasRoutes({
      ...deps,
      completer: vertexCompleter(deps.models, {
        groups: {
          text_fast: deps.config.llm.textFast,
          multi_modal_fast: deps.config.llm.multiModalFast,
          multi_modal_pro: deps.config.llm.multiModalPro,
        },
      }),
      canvasEnabled: deps.config.canvas.enabled,
    }),
  );
  app.route(
    "/",
    tenancyRoutes({
      db: deps.db,
      accessStore: new DrizzleAccessStore(deps.db),
      jobs: queueSink(deps.queue),
      dashboardUrl: deps.config.http.dashboardUrl,
      inviteSecret: deps.config.account.inviteHashSecret,
    }),
  );
  app.route("/", billingRoutes(deps));
  app.route("/", mollieWebhookRoutes(deps));
  app.route("/", staffRoutes(deps));
  app.route("/", trainingRoutes(deps));
  app.route(
    "/",
    feedbackReportRoutes({ ...deps, storage: deps.files, apiBaseUrl: deps.config.http.publicUrl }),
  );
  app.route("/", responseRoutes(deps));
  app.route("/", pricingRoutes({ ...deps, storage: deps.files }));
  app.route("/", statsRoutes(deps));
  const conversations: ConversationsDeps = {
    db: deps.db,
    access: deps.access,
    audio: deps.audio,
    audioUrls: new AudioUrls(
      deps.config.audio.s3Endpoint ?? `${deps.config.http.publicUrl}/_local-audio`,
      deps.config.audio.s3Bucket ?? "local",
    ),
    jobs: deps.queue,
    models: deps.models,
    media: deps.media,
    transcriber: deps.transcriber,
    hub: deps.hub,
    limiter: deps.limiter,
    logger: deps.logger,
    tokens: new ParticipantTokens(
      deps.config.auth.secret,
      deps.config.conversations.participantTokenRequired,
    ),
    settings: {
      participantTokenRequired: deps.config.conversations.participantTokenRequired,
      monitorEnabled: deps.config.conversations.monitorEnabled,
      webhooksEnabled: deps.config.webhooks.enabled,
      dashboardUrl: deps.config.http.dashboardUrl,
    },
    now: () => new Date(),
  };
  app.route("/", conversationRoutes(conversations));
  app.route("/", verifyRoutes(conversations));
  // Local and test only: the stand-in for the buckets' presigned URLs.
  const local = deps.config.app.env === "local" || deps.config.app.env === "test";
  for (const store of [deps.files, deps.audio])
    if (local && store instanceof FilesystemStorage) {
      const handle = localStorageHandler(store, store.routePath);
      app.all(store.routePath, (c) => handle(c.req.raw));
      app.all(`${store.routePath}/*`, (c) => handle(c.req.raw));
    }
  app.onError(onError);
  app.notFound(notFound);
  return app;
}
