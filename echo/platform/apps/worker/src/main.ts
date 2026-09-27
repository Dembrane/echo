import { describe, loadSections } from "@echo/config";
import { createDb } from "@echo/db";
import { createModels, vertexCompleter, vertexEmbedder } from "@echo/llm";
import { type Mailer, SendGridMailer } from "@echo/mail";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { queueSink } from "@echo/tenancy";
import { registrations } from "./jobs";

// Only what the worker reads: it never serves sign-in, so it is not given the auth secret.
const loaded = loadSections([
  "app",
  "database",
  "observability",
  "llm",
  "webhooks",
  "http",
  "mail",
  "analysis",
  "canvas",
  "reports",
]);
const config = loaded.values;
const service = "echo-worker";
const logger = createLogger({
  service,
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
  ...(config.observability.gcpProject && { gcpProject: config.observability.gcpProject }),
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
// Without a SendGrid key (local, preview) mail is logged, never sent.
const mailer: Mailer = config.mail.sendgridApiKey
  ? new SendGridMailer({
      apiKey: config.mail.sendgridApiKey,
      fromEmail: config.mail.fromEmail,
      fromName: config.mail.fromName,
      region: config.mail.sendgridRegion,
    })
  : {
      send: async (msg) =>
        logger.warn({ subject: msg.subject, tags: msg.tags }, "mail not sent: no SendGrid key"),
    };
// Language model groups and embeddings for the analysis, map, canvas and report jobs.
const models = createModels({
  vertexProject: config.llm.vertexProject,
  vertexLocation: config.llm.vertexLocation,
  groups: {
    text_fast: config.llm.textFast,
    multi_modal_fast: config.llm.multiModalFast,
    multi_modal_pro: config.llm.multiModalPro,
  },
  embeddingModel: config.llm.embeddingModel,
  embeddingLocation: config.llm.embeddingLocation,
  embeddingDimensions: config.llm.embeddingDimensions,
});
const completer = vertexCompleter(models, {
  groups: {
    text_fast: config.llm.textFast,
    multi_modal_fast: config.llm.multiModalFast,
    multi_modal_pro: config.llm.multiModalPro,
  },
});
const embedder = vertexEmbedder(models, {
  project: config.llm.vertexProject,
  location: config.llm.embeddingLocation,
  model: config.llm.embeddingModel,
});
const regs = registrations({
  logger,
  db: database.db,
  config,
  mailer,
  jobs: queueSink(queue),
  dashboardUrl: config.http.dashboardUrl,
  completer,
  embedder,
});
await queue.start(regs.flatMap((r) => r.jobs));
for (const r of regs) await r.register(queue);
await queue.run();
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
