import { DrizzleAccessStore } from "@echo/access";
import { accountRoutes } from "@echo/account";
import { analysisRoutes } from "@echo/analysis";
import { canvasRoutes } from "@echo/canvas";
import { vertexCompleter, vertexEmbedder } from "@echo/llm";
import { mapRoutes } from "@echo/map";
import { notificationRoutes } from "@echo/notifications";
import { projectRoutes } from "@echo/projects";
import { reportRoutes } from "@echo/reports";
import { queueSink, tenancyRoutes } from "@echo/tenancy";
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
      exposeHeaders: ["x-request-id"],
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
  app.onError(onError);
  app.notFound(notFound);
  return app;
}
