import { queueJobs } from "@dembrane/accounts";
import { HttpMedia, LocalMedia, metadataIdToken } from "@dembrane/audio";
import { createBilling, HttpMollie, UnconfiguredMollie } from "@dembrane/billing";
import { describe, loadSections } from "@dembrane/config";
import { AudioUrls } from "@dembrane/conversations";
import { bootAssets } from "@dembrane/core";
import { createDb, withDatabase } from "@dembrane/db";
import { createModels, vertexCompleter, vertexEmbedder } from "@dembrane/llm";
import { type Mailer, SendGridMailer } from "@dembrane/mail";
import { createLogger, initTracing } from "@dembrane/observability";
import { Queue } from "@dembrane/queue";
import { FilesystemStorage, requireBucket, S3Storage } from "@dembrane/storage";
import { queueSink } from "@dembrane/tenancy";
import { GeminiTranscriber } from "@dembrane/transcription";
import { WORKER_ASSETS } from "./assets";
import { registrations } from "./jobs";

// Before anything else, and before the configuration that needs secrets: an image that
// lacks a file the worker reads exits here instead of failing jobs. `--check-assets` stops
// after this check, which is how CI proves the image without a database.
bootAssets("echo-worker", loadSections(["assets"]).values.assets.root, WORKER_ASSETS);

// Only what the worker reads: it never serves sign-in, so it is not given the auth secret.
const loaded = loadSections([
  "app",
  "database",
  "observability",
  "llm",
  "webhooks",
  "http",
  "mail",
  "audio",
  "media",
  "billing",
  "support",
  "analysis",
  "canvas",
  "reports",
  "agentic",
  "accounts",
  "files",
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

const databaseUrl = withDatabase(config.database.url, config.database.name);
const queue = new Queue(databaseUrl, logger, tracing.tracer, {
  maxConnections: config.database.poolMax,
});
const database = createDb({ url: databaseUrl, poolMax: config.database.poolMax });
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
// The model groups serve the conversation pipeline (with the audio bucket, ffmpeg from the
// media service in the cloud or in-process locally, and Gemini transcription) and the
// analysis, map, canvas and report jobs, which also embed, and the chat assistant.
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
const audio = config.audio.s3Bucket
  ? new S3Storage({
      endpoint: config.audio.s3Endpoint ?? "",
      bucket: config.audio.s3Bucket,
      region: config.audio.s3Region,
      accessKeyId: config.audio.s3AccessKeyId ?? "",
      secretAccessKey: config.audio.s3SecretAccessKey ?? "",
    })
  : new FilesystemStorage(config.audio.localRoot, config.http.publicUrl, "/_local-audio");
// The API's file bucket: offer PDFs of demos made in echo are written here and served by the API.
const files = config.files.s3Bucket
  ? new S3Storage({
      endpoint: config.files.s3Endpoint ?? "",
      bucket: config.files.s3Bucket,
      region: config.files.s3Region,
      accessKeyId: config.files.s3AccessKeyId ?? "",
      secretAccessKey: config.files.s3SecretAccessKey ?? "",
    })
  : new FilesystemStorage(config.files.localRoot, config.http.publicUrl);
// Deployed environments keep files and audio in their buckets; refuse to start otherwise.
requireBucket(config.app.env, files, "Offer PDFs of demos", "FILES_S3_BUCKET");
requireBucket(config.app.env, audio, "Participant audio", "STORAGE_S3_BUCKET");
const local = config.app.env === "local" || config.app.env === "test";
const media = config.media.url
  ? new HttpMedia(config.media.url, {
      timeoutMs: config.media.timeoutSeconds * 1000,
      ...(!local && { idToken: metadataIdToken(config.media.url) }),
    })
  : new LocalMedia();

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
  accountsJobs: queueJobs(queue),
  files,
  dashboardUrl: config.http.dashboardUrl,
  billing,
  conversations: {
    db: database.db,
    audio,
    audioUrls: new AudioUrls(
      config.audio.s3Endpoint ?? `${config.http.publicUrl}/_local-audio`,
      config.audio.s3Bucket ?? "local",
    ),
    media,
    transcriber: new GeminiTranscriber(models, logger),
    models,
    jobs: queue,
    logger,
    now: () => new Date(),
    webhooks: { enabled: config.webhooks.enabled, dashboardUrl: config.http.dashboardUrl },
  },
  completer,
  embedder,
  models,
  databaseUrl,
  popcorn: { databaseUrl, portalUrl: config.http.portalUrl },
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
