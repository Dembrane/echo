import { createBilling, HttpMollie, UnconfiguredMollie } from "@echo/billing";
import { describe, loadConfig } from "@echo/config";
import { createDb } from "@echo/db";
import { type Mailer, SendGridMailer } from "@echo/mail";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { registrations } from "./jobs";

const loaded = loadConfig();
const config = loaded.values;
const service = "echo-worker";
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

const queue = new Queue(config.database.url, logger, tracing.tracer, {
  maxConnections: config.database.poolMax,
});
const database = createDb({ url: config.database.url, poolMax: config.database.poolMax });
// Without a SendGrid key sends are logged, never delivered.
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
const regs = registrations({ logger, config, db: database.db, mailer, billing });
await queue.start(regs.flatMap((r) => r.jobs));
for (const r of regs) await r.register(queue);
logger.info(
  { jobs: regs.flatMap((r) => r.jobs.map((j) => j.name)), config: describe(loaded) },
  "worker started",
);

// Queue depth is a health signal: logged each minute so a log-based metric can alert on it.
const signals = setInterval(async () => {
  try {
    for (const q of await queue.health())
      logger.info({ signal: "queue.depth", ...q }, "queue health");
  } catch (err) {
    logger.warn({ err }, "queue health unavailable");
  }
}, 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker stopping");
  clearInterval(signals);
  await queue.stop();
  await Promise.allSettled([database.close(), tracing.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
