import { emailHandler, sendEmail } from "@echo/account";
import { type AccountsJobs, accountsWorker, httpFetchText } from "@echo/accounts";
import { agenticWorker } from "@echo/agentic";
import { analysisWorker } from "@echo/analysis";
import { type Billing, billingRegistration } from "@echo/billing";
import { canvasWorker } from "@echo/canvas";
import type { Config } from "@echo/config";
import { conversationWorker, liveRecordings, type PipelineDeps } from "@echo/conversations";
import type { Db } from "@echo/db";
import type { Completer, Embedder, Models } from "@echo/llm";
import type { Mailer } from "@echo/mail";
import { mapWorker } from "@echo/map";
import type { Logger } from "@echo/observability";
import { popcornDeckHook, popcornFlags, popcornWorker, runtimeAnalysis } from "@echo/popcorn";
import { presentAdoption } from "@echo/present";
import { environmentName, httpForwarder, pricingRegistration, pricingStorage } from "@echo/pricing";
import { defineJob, type JobDefinition, type Queue } from "@echo/queue";
import { reportsWorker } from "@echo/reports";
import { type JobSink, tenancyWorker } from "@echo/tenancy";
import { dispatchWebhook, httpDeliver, runDispatch, webhooksStorage } from "@echo/webhooks";
import { z } from "zod";

/**
 * Fires every minute on exactly one worker instance. Its log line is the signal that
 * schedules run; the alert on its absence is the first thing that tells us the worker
 * pool or the queue is down.
 */
export const heartbeat = defineJob("system.heartbeat", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 60,
});

export interface Registration {
  readonly jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
}

/** Every job this worker runs. Namespaces add their registration here as they move over. */
export function registrations(deps: {
  logger: Logger;
  db: Db;
  config: Pick<
    Config,
    | "webhooks"
    | "billing"
    | "support"
    | "llm"
    | "analysis"
    | "canvas"
    | "reports"
    | "agentic"
    | "http"
    | "database"
    | "accounts"
  >;
  /** Sends the email jobs enqueue. */
  mailer: Mailer;
  /** Lets a job enqueue follow-up jobs (the support timers send email). */
  jobs: JobSink;
  /** The same, with run ids: account reminders are sent once per task and due time. */
  accountsJobs: AccountsJobs;
  /** Where email buttons point. */
  dashboardUrl: string;
  /** Mollie, the billing store and its notifier, shared by the billing jobs. */
  billing: Billing;
  /** The conversation pipeline: storage, media, transcription and models. */
  conversations: PipelineDeps;
  /** Language model calls of the analysis, map, canvas and report jobs. */
  completer: Completer;
  /** Embeddings of analysis objects. */
  embedder: Embedder;
  /** The model groups the chat assistant runs on. */
  models: Models;
  /** Where the popcorn tick enqueues its workflows and where participant links point. */
  popcorn: { databaseUrl: string; portalUrl: string };
}): Registration[] {
  const { logger, db, config } = deps;
  // Pricing bookings and overage notices share the team's webhook.
  const teamWebhook =
    config.support.forwardWebhookUrl && config.support.forwardWebhookToken
      ? httpForwarder(config.support.forwardWebhookUrl, config.support.forwardWebhookToken)
      : null;
  const analysisDeps = {
    db,
    logger,
    completer: deps.completer,
    embedder: deps.embedder,
    config: {
      embeddingModel: config.llm.embeddingModel,
      embeddingLocation: config.llm.embeddingLocation,
    },
  };
  return [
    {
      jobs: [heartbeat],
      async register(queue) {
        await queue.work(heartbeat, { concurrency: 1 }, async () => {
          logger.info({ signal: "worker.heartbeat" }, "heartbeat");
        });
        await queue.schedule(heartbeat, "* * * * *", {});
      },
    },
    {
      jobs: [dispatchWebhook],
      async register(queue) {
        const store = webhooksStorage(db);
        const deliver = httpDeliver({ allowPrivate: config.webhooks.allowPrivateTargets });
        // Deliveries wait on other people's servers, so many run at once.
        await queue.work(dispatchWebhook, { concurrency: 20 }, (p) =>
          runDispatch({ store, deliver, logger }, p),
        );
      },
    },
    {
      jobs: [sendEmail],
      async register(queue) {
        await queue.work(sendEmail, { concurrency: 10 }, emailHandler(deps.mailer, logger));
      },
    },
    tenancyWorker(deps),
    billingRegistration({
      billing: deps.billing,
      mailer: deps.mailer,
      logger,
      customerJobs: config.billing.customerJobs === "on",
      dashboardUrl: deps.dashboardUrl,
      overage: {
        db,
        // Live portal recordings from the presence store the portal's pings write.
        live: liveRecordings({ db, logger }),
        forwarder: teamWebhook,
        environment: environmentName(deps.dashboardUrl),
      },
    }),
    popcornWorker({
      db,
      logger,
      completer: deps.completer,
      flags: popcornFlags(config),
      participantBaseUrl: deps.popcorn.portalUrl,
      adminBaseUrl: deps.dashboardUrl,
      databaseUrl: deps.popcorn.databaseUrl,
      analysis: runtimeAnalysis(analysisDeps, (rt, deck, jobs) =>
        presentAdoption({
          rt,
          deck,
          jobs,
          db,
          logger,
          flags: popcornFlags(config),
          participantBaseUrl: deps.popcorn.portalUrl,
          adminBaseUrl: deps.dashboardUrl,
          ceilings: {
            nodeLimit: config.analysis.nodeLimitCeiling ?? null,
            edgeLimit: config.analysis.edgeLimitCeiling ?? null,
          },
        }),
      ),
    }),
    pricingRegistration({
      store: pricingStorage(db),
      forwarder: teamWebhook,
      environment: environmentName(deps.dashboardUrl),
      logger,
    }),
    conversationWorker(deps.conversations),
    canvasWorker({
      db: deps.db,
      logger,
      completer: deps.completer,
      canvasEnabled: config.canvas.enabled,
    }),
    reportsWorker(deps),
    // The deck view follows the popcorn, tensions and stakeholders publications.
    analysisWorker({ ...analysisDeps, snapshotHooks: [popcornDeckHook(db, logger)] }),
    mapWorker({
      db: deps.db,
      logger,
      completer: deps.completer,
      embedder: deps.embedder,
      config: {
        embeddingModel: config.llm.embeddingModel,
        embeddingLocation: config.llm.embeddingLocation,
      },
    }),
    accountsWorker({
      db,
      mailer: deps.mailer,
      logger,
      jobs: deps.accountsJobs,
      deliver: httpDeliver({ allowPrivate: config.webhooks.allowPrivateTargets }),
      dashboardUrl: deps.dashboardUrl,
      eventsUrl: config.accounts.eventsUrl ?? null,
      eventsSecret: config.accounts.eventsSecret ?? null,
      slackWebhookUrl: config.accounts.slackWebhookUrl ?? null,
      reminderIntervalDays: config.accounts.reminderIntervalDays,
      fetchText: httpFetchText,
    }),
    agenticWorker({
      db,
      logger,
      config,
      databaseUrl: config.database.url,
      models: deps.models,
    }),
  ];
}
