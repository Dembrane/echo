import { DrizzleAccessStore } from "@echo/access";
import { accountRoutes } from "@echo/account";
import { notificationRoutes } from "@echo/notifications";
import { projectRoutes } from "@echo/projects";
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
