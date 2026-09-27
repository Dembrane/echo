import { Access, DrizzleAccessStore, DrizzleStaffAudit } from "@echo/access";
import { render, sendEmail } from "@echo/account";
import { createAuth, identityAccount } from "@echo/auth";
import { billingApiJobs, createBilling, HttpMollie, UnconfiguredMollie } from "@echo/billing";
import { describe, loadConfig, publicValues } from "@echo/config";
import { createDb } from "@echo/db";
import { createModels } from "@echo/llm";
import { type Mailer, MemoryMailer, SendGridMailer } from "@echo/mail";
import { Notifier } from "@echo/notifications";
import { createLogger, initTracing } from "@echo/observability";
import { popcornApiJobs } from "@echo/popcorn";
import { projectJobs } from "@echo/projects";
import { Queue } from "@echo/queue";
import { PostgresRateCounter, RateLimiter } from "@echo/ratelimit";
import { FilesystemStorage, S3Storage } from "@echo/storage";
import { tenancyApiJobs } from "@echo/tenancy";
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
  ...(config.observability.gcpProject && { gcpProject: config.observability.gcpProject }),
});
const tracing = initTracing({
  service,
  release: config.app.release,
  env: config.app.env,
  otlpEndpoint: config.observability.otlpEndpoint,
  sampleRatio: config.observability.traceSampleRatio,
});
const database = createDb({ url: config.database.url, poolMax: config.database.poolMax });

// Auth emails go out inside the request: the person is waiting for the code or the link.
const mailer: Mailer = config.mail.sendgridApiKey
  ? new SendGridMailer({
      apiKey: config.mail.sendgridApiKey,
      fromEmail: config.mail.fromEmail,
      fromName: config.mail.fromName,
      region: config.mail.sendgridRegion,
    })
  : new MemoryMailer();
if (!config.mail.sendgridApiKey)
  logger.warn("no SENDGRID_API_KEY: emails are kept in memory, not sent");

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
  sendCode: async (email, code, purpose) => {
    await mailer.send({
      to: email,
      subject: "Your dembrane sign-in code",
      ...render({ template: "sign_in_code", data: { code } }),
      tags: ["sign_in_code", purpose],
    });
  },
  // The link carries the dashboard page the signup named (Directus's verification_url
  // contract), which then confirms the token with Better Auth.
  sendVerification: async (email, url, token) => {
    const page = new URL(url).searchParams.get("callbackURL");
    const link = page ? `${page}${page.includes("?") ? "&" : "?"}token=${token}` : url;
    await mailer.send({
      to: email,
      subject: "Verify your email",
      ...render({ template: "verify_email", data: { verify_url: link } }),
      tags: ["verify_email"],
    });
  },
  defaultDirectusRoleId: null,
});

// The API only enqueues: a DBOS client, no executor. Boot does not wait on it, so a
// database that is briefly unreachable does not keep the API from serving; enqueues wait.
const queue = new Queue(config.database.url, logger, tracing.tracer, { maxConnections: 2 });
const queueReady = (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await queue.start([
        ...projectJobs,
        ...webhookJobs,
        ...tenancyApiJobs,
        ...billingApiJobs,
        ...popcornApiJobs,
        sendEmail,
      ]);
      return;
    } catch (err) {
      logger.warn(
        { err: { message: (err as Error).message }, attempt },
        "queue not ready, retrying",
      );
      await Bun.sleep(Math.min(attempt, 10) * 1000);
    }
  }
})();
const enqueuer = {
  enqueue: (async (def, payload, opts) => {
    await queueReady;
    return queue.enqueue(def, payload, opts);
  }) as Queue["enqueue"],
};

const files = config.files.s3Bucket
  ? new S3Storage({
      endpoint: config.files.s3Endpoint ?? "",
      bucket: config.files.s3Bucket,
      region: config.files.s3Region,
      accessKeyId: config.files.s3AccessKeyId ?? "",
      secretAccessKey: config.files.s3SecretAccessKey ?? "",
    })
  : new FilesystemStorage(config.files.localRoot, config.http.publicUrl);

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
  models: createModels({
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
  }),
  queue: enqueuer,
  deliverWebhook: httpDeliver({ allowPrivate: config.webhooks.allowPrivateTargets }),
  identity: identityAccount(auth, database.db),
  notifier: new Notifier(database.db, logger),
  limiter: new RateLimiter(new PostgresRateCounter(database.db), undefined, (err, limit) =>
    logger.error(
      {
        err: { message: (err as Error).message },
        limit: limit.name,
        signal: "ratelimit.store_failed",
      },
      "rate limit store failed; request not limited",
    ),
  ),
  jobs: enqueuer,
  files,
  staffAudit: new DrizzleStaffAudit(database.db),
  mailer,
  billing,
  siteToken: config.site.apiToken ?? config.support.forwardWebhookToken ?? null,
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
