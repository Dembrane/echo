import { queueJobs } from "@dembrane/accounts";
import { HttpMedia, LocalMedia, mediaAuth } from "@dembrane/audio";
import { createBilling, HttpMollie, UnconfiguredMollie } from "@dembrane/billing";
import { describe, FIXED_CONNECTIONS, loadSections } from "@dembrane/config";
import { AudioUrls } from "@dembrane/conversations";
import { bootAssets } from "@dembrane/core";
import { createDb, describeDbFailure, withDatabase } from "@dembrane/db";
import {
  checkProfileModels,
  completerConfigOf,
  createModels,
  embedderConfigOf,
  type LlmSettings,
  type Models,
  modelsConfigOf,
  profileGaps,
  profileOf,
  vertexCompleter,
  vertexEmbedder,
} from "@dembrane/llm";
import { type Mailer, mailerFromSettings, missingMailKey } from "@dembrane/mail";
import { modelCallRecorder, modelCallTable } from "@dembrane/metering";
import { createLogger, initTracing } from "@dembrane/observability";
import { Queue } from "@dembrane/queue";
import { FilesystemStorage, requireBucket, S3Storage } from "@dembrane/storage";
import { queueSink } from "@dembrane/tenancy";
import {
  DEFAULT_RETRY,
  editSentences,
  type FinalTranscriber,
  GeminiFinal,
  GeminiTranscriber,
  requestLimits,
  WhisperFinal,
} from "@dembrane/transcription";
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
  "samInbox",
  "samples",
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
  maxConnections: config.database.queuePoolMax,
  clientConnections: FIXED_CONNECTIONS.workerQueueClient,
  release: config.app.release,
});
const database = createDb({ url: databaseUrl, poolMax: config.database.poolMax });
// Without a sender configured (local, preview) mail is logged, never sent.
const mailer: Mailer = mailerFromSettings(config.mail) ?? {
  send: async (msg) =>
    logger.warn(
      { subject: msg.subject, tags: msg.tags },
      config.mail.provider === "scaleway"
        ? `mail not sent: no ${missingMailKey(config.mail)}`
        : "mail not sent: no SendGrid key",
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
// The model groups serve the conversation pipeline (with the audio bucket, ffmpeg from the
// media service in the cloud or in-process locally, and Gemini transcription) and the
// analysis, map, canvas and report jobs, which also embed, and the chat assistant.
// Every model call is metered: one log line at once and one model_call row per batch.
const metering = modelCallRecorder({ sink: modelCallTable(database.db), logger, service });
// One structured line per request to a speech model: what is sent, how long it took, how it ended.
const logSpeech = (e: object) => logger.info({ signal: "speech.request", ...e }, "speech request");
// The transcription pipeline is one named profile (packages/llm/src/profiles.ts). A deployment
// that lacks what it needs stops here, naming the profile and the missing setting, instead of
// failing every recording later.
const profile = (() => {
  try {
    return profileOf(config.llm);
  } catch (err) {
    logger.fatal({ signal: "worker.boot_failed" }, (err as Error).message);
    logger.flush();
    process.exit(1);
  }
})();
const gap = profileGaps(profile, config.llm);
if (gap) {
  logger.fatal({ signal: "worker.boot_failed", profile: profile.name }, gap);
  logger.flush();
  process.exit(1);
}
logger.info({ profile: profile.name }, "transcription profile");
void checkProfileModels(profile, config.llm, (line) =>
  logger.warn({ signal: "transcription.profile_models", profile: profile.name }, line),
);
const modelHooks = {
  onSpeechRequest: logSpeech,
  observe: metering.observe,
  onObserverFault: (err: unknown) =>
    logger.warn({ err }, "model call metering failed; later faults are silent"),
};
const models = createModels(modelsConfigOf(config.llm, profile), modelHooks);
/**
 * Models on one speech provider whatever LLM_PROVIDER serves chat: the profile's Gemini model
 * leads that provider's audio group (its fallbacks follow), and on the compatible provider the
 * profile's clean-up model is the text model.
 */
const speechModels = (provider: "whisper" | "gemini", geminiModel?: string): Models => {
  const s: LlmSettings = {
    ...config.llm,
    provider: provider === "whisper" ? "openai-compatible" : "vertex",
    ...(geminiModel && {
      multiModalPro: [geminiModel, ...config.llm.multiModalPro.filter((m) => m !== geminiModel)],
    }),
    ...(profile.cleanUp && { compatTextFast: [profile.cleanUp.model] }),
  };
  return createModels(modelsConfigOf(s, profile), modelHooks);
};
const retry = profile.live.secondListen ? DEFAULT_RETRY : null;
const liveModels =
  profile.live.provider === "whisper"
    ? speechModels("whisper")
    : speechModels("gemini", profile.live.model);
const transcriber = new GeminiTranscriber(liveModels, logger, { retry });
const liveLimits = requestLimits(profile.live.provider);
const redoesAnything =
  profile.redo !== null && (profile.recordings === "redo" || profile.uploads === "redo");
const redoModels =
  redoesAnything && profile.redo
    ? profile.redo.provider === "whisper"
      ? speechModels("whisper")
      : speechModels("gemini", profile.redo.model)
    : null;
// The clean-up reads Whisper's sentences with the compatible provider's text model.
const cleanUpModels = profile.cleanUp ? speechModels("whisper") : null;
const finalTranscriber: FinalTranscriber | null =
  redoModels && profile.redo
    ? profile.redo.provider === "whisper"
      ? new WhisperFinal(redoModels, { retry })
      : new GeminiFinal(redoModels, logger)
    : null;
const finalProvider = profile.redo?.provider ?? profile.live.provider;
const audio = config.audio.s3Bucket
  ? new S3Storage({
      endpoint: config.audio.s3Endpoint ?? "",
      bucket: config.audio.s3Bucket,
      region: config.audio.s3Region,
      accessKeyId: config.audio.s3AccessKeyId ?? "",
      secretAccessKey: config.audio.s3SecretAccessKey ?? "",
      prefix: config.audio.s3Prefix,
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
      prefix: config.files.s3Prefix,
    })
  : new FilesystemStorage(config.files.localRoot, config.http.publicUrl);
// Deployed environments keep files and audio in their buckets; refuse to start otherwise.
requireBucket(config.app.env, files, "Offer PDFs of demos", "FILES_S3_BUCKET");
requireBucket(config.app.env, audio, "Participant audio", "STORAGE_S3_BUCKET");
const local = config.app.env === "local" || config.app.env === "test";
const media = config.media.url
  ? new HttpMedia(config.media.url, {
      timeoutMs: config.media.timeoutSeconds * 1000,
      ...(!local && mediaAuth(config.media.auth, config.media.url)),
    })
  : new LocalMedia();

const completer = vertexCompleter(models, completerConfigOf(config.llm));
const embedder = vertexEmbedder(models, embedderConfigOf(config.llm));
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
    transcriber,
    liveProvider: profile.live.provider,
    ...(config.llm.whisperMaxRequestSeconds && {
      requestLimits: {
        ...liveLimits,
        maxSeconds: Math.min(liveLimits.maxSeconds, config.llm.whisperMaxRequestSeconds),
      },
    }),
    ...((profile.recordings !== "none" || profile.uploads !== "none") && {
      final: {
        profile: profile.name,
        recordings: profile.recordings,
        uploads: profile.uploads,
        timedPieceSeconds: profile.timedPieceSeconds,
        providers: [finalProvider],
        transcribers: finalTranscriber ? { [finalProvider]: finalTranscriber } : {},
        ...(cleanUpModels && {
          edit: {
            providers: ["whisper" as const],
            run: (sentences, ctx) => editSentences(cleanUpModels as Models, sentences, ctx, logger),
          },
        }),
        redact: async (text, o) =>
          (
            await transcriber.redactText({
              text,
              language: o.language,
              usePiiRedaction: true,
              anonymizeTranscripts: true,
              customGuidancePrompt: o.customGuidancePrompt,
              hotwords: o.hotwords,
            })
          ).transcript,
      },
    }),
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
// A worker that cannot start says why in one line before it exits: Cloud Run restarts it
// either way, and the line (signal worker.boot_failed) is what the person on call reads.
try {
  // The database first, through the same connect() every pool uses, so an unreachable
  // server is named before DBOS's own retries fill the log.
  await database.ping();
  await queue.start(regs.flatMap((r) => r.jobs));
  for (const r of regs) await r.register(queue);
  await queue.run();
} catch (err) {
  const db = describeDbFailure(err, databaseUrl);
  if (db)
    logger.fatal(
      { signal: "worker.boot_failed", cause: db.cause, target: db.target, detail: db.detail },
      db.message,
    );
  else logger.fatal({ signal: "worker.boot_failed", err }, "worker failed to start");
  logger.flush();
  process.exit(1);
}
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
  // The queue hands this worker's running jobs to the others only after everything here is
  // closed, and the exit follows at once: a step still in flight ends with the process.
  await queue.stop(async () => {
    await metering.flush();
    await Promise.allSettled([database.close(), tracing.shutdown()]);
  });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
