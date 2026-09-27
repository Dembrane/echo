import { Access, DrizzleAccessStore } from "@echo/access";
import { createAuth } from "@echo/auth";
import { describe, loadConfig, publicValues } from "@echo/config";
import { createDb } from "@echo/db";
import { createLogger, initTracing } from "@echo/observability";
import { projectJobs } from "@echo/projects";
import { Queue } from "@echo/queue";
import { httpDeliver, webhookJobs } from "@echo/webhooks";
import { buildApp } from "./app";
import { principalLookup } from "./principals";

const loaded = loadConfig();
const config = loaded.values;
const service = "echo-api";
const logger = createLogger({
  service,
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
});
const tracing = initTracing({
  service,
  release: config.app.release,
  env: config.app.env,
  otlpEndpoint: config.observability.otlpEndpoint,
  sampleRatio: config.observability.traceSampleRatio,
});
const database = createDb({ url: config.database.url, poolMax: config.database.poolMax });

const auth = createAuth({
  db: database.db,
  secret: config.auth.secret,
  baseURL: config.http.publicUrl,
  trustedOrigins: [config.http.dashboardUrl, config.http.portalUrl],
  cookieDomain: config.auth.cookieDomain,
  secureCookies: config.app.env !== "local" && config.app.env !== "test",
  google:
    config.auth.googleClientId && config.auth.googleClientSecret
      ? { clientId: config.auth.googleClientId, clientSecret: config.auth.googleClientSecret }
      : undefined,
  // The mail package replaces this before any environment offers email codes to users.
  sendCode: async (email, _code, purpose) => {
    logger.warn(
      { purpose, to_domain: email.split("@")[1] },
      "email code requested but no mailer is configured",
    );
  },
  defaultDirectusRoleId: null,
});

// The API only sends jobs; creating their queues up front lets it send before a worker ran.
const queue = new Queue(config.database.url, logger, tracing.tracer, { maxConnections: 2 });
await queue.start([...projectJobs, ...webhookJobs]);

const app = buildApp({
  config,
  publicConfig: publicValues(loaded),
  logger,
  tracer: tracing.tracer,
  pingDb: database.ping,
  auth,
  principalFor: principalLookup(database.db),
  access: new Access(new DrizzleAccessStore(database.db)),
  db: database.db,
  queue,
  deliverWebhook: httpDeliver({ allowPrivate: config.webhooks.allowPrivateTargets }),
});

const server = Bun.serve({ port: config.http.port, fetch: app.fetch, idleTimeout: 255 });
logger.info({ port: server.port, config: describe(loaded) }, "api started");

// Cloud Run sends SIGTERM and allows 10s: stop taking requests, finish in-flight ones, flush.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  await server.stop();
  await Promise.allSettled([queue.stop(), database.close(), tracing.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
