import { DrizzleAccessStore } from "@echo/access";
import { accountRoutes } from "@echo/account";
import {
  AudioUrls,
  type ConversationsDeps,
  conversationRoutes,
  PARTICIPANT_TOKEN_HEADER,
  ParticipantTokens,
} from "@echo/conversations";
import { notificationRoutes } from "@echo/notifications";
import { projectRoutes } from "@echo/projects";
import { FilesystemStorage, localStorageHandler } from "@echo/storage";
import { queueSink, tenancyRoutes } from "@echo/tenancy";
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
