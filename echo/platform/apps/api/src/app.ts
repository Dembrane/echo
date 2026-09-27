import { DrizzleAccessStore } from "@echo/access";
import { accountRoutes } from "@echo/account";
import { billingRoutes, mollieWebhookRoutes } from "@echo/billing";
import { reportRoutes, responseRoutes } from "@echo/feedback";
import { notificationRoutes } from "@echo/notifications";
import {
  mapNotReady,
  noCapture,
  popcornDeps,
  popcornFlags,
  popcornRoutes,
  posthogCapture,
  publicRoutes,
  queueDispatch,
  sqlDeckAnalysis,
} from "@echo/popcorn";
import { pricingRoutes } from "@echo/pricing";
import { projectRoutes } from "@echo/projects";
import { sharedHub } from "@echo/realtime";
import { staffRoutes } from "@echo/staff";
import { statsRoutes } from "@echo/stats";
import { queueSink, tenancyRoutes } from "@echo/tenancy";
import { trainingRoutes } from "@echo/training";
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
    reportRoutes({ ...deps, storage: deps.files, apiBaseUrl: deps.config.http.publicUrl }),
  );
  app.route("/", responseRoutes(deps));
  app.route("/", pricingRoutes({ ...deps, storage: deps.files }));
  app.route("/", statsRoutes(deps));
  const sql = (deps.db as unknown as { $client: Parameters<typeof sharedHub>[0] }).$client;
  const popcorn = popcornDeps({
    db: deps.db,
    deck: sqlDeckAnalysis(sql),
    flags: popcornFlags(deps.config),
    participantBaseUrl: deps.config.http.portalUrl,
    adminBaseUrl: deps.config.http.dashboardUrl,
    showFlow: deps.config.popcorn.showFlow,
    dispatchTick: queueDispatch(deps.queue),
    limiter: deps.limiter,
    logger: deps.logger,
  });
  const hub = () => sharedHub(sql, deps.logger);
  const capture =
    deps.config.app.env === "test"
      ? noCapture
      : posthogCapture(deps.config.http.dashboardUrl, deps.logger);
  app.route("/", popcornRoutes({ ...popcorn, access: deps.access, hub, capture }));
  app.route("/", publicRoutes({ ...popcorn, hub, audienceMap: mapNotReady }));
  app.onError(onError);
  app.notFound(notFound);
  return app;
}
