import { Access, DrizzleAccessStore, DrizzleStaffAudit } from "@echo/access";
import { createAuth } from "@echo/auth";
import { createBilling, HttpMollie, UnconfiguredMollie } from "@echo/billing";
import { describe, loadConfig, publicValues } from "@echo/config";
import { createDb } from "@echo/db";
import { type Mailer, SendGridMailer } from "@echo/mail";
import { createLogger, initTracing } from "@echo/observability";
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

// Without a SendGrid key (local, parity) sends are logged, never delivered.
const mailer: Mailer = config.mail.sendgridApiKey
  ? new SendGridMailer({
      apiKey: config.mail.sendgridApiKey,
      region: config.mail.sendgridRegion,
      fromEmail: config.mail.fromEmail,
      fromName: config.mail.fromName,
    })
  : {
      send: async (m) =>
        logger.warn(
          { tags: m.tags, to_domain: m.to.split("@")[1] },
          "email not sent: no mailer configured",
        ),
    };
const billing = createBilling({
  db: database.db,
  mollie: config.billing.mollieApiKey
    ? new HttpMollie(config.billing.mollieApiKey)
    : new UnconfiguredMollie(),
  mailer,
  logger,
  billingConfig: {
    webhookUrl: config.billing.mollieWebhookUrl ?? null,
    forceReconcileFailure: config.billing.forceReconcileFailure,
    dashboardUrl: config.http.dashboardUrl,
  },
});

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
  staffAudit: new DrizzleStaffAudit(database.db),
  mailer,
  billing,
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
  await Promise.allSettled([database.close(), tracing.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
