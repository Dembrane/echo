import { Access, DrizzleAccessStore, DrizzleStaffAudit } from "@dembrane/access";
import { emailHandler, sendEmail } from "@dembrane/account";
import {
  type AccountsJobs,
  accountsWorker,
  DEMO_IDS,
  demoBuildAccess,
  demoHttpGet,
  httpFetchText,
  queueJobs,
} from "@dembrane/accounts";
import { agenticWorker } from "@dembrane/agentic";
import { analysisWorker } from "@dembrane/analysis";
import { type Billing, billingRegistration, overageInboxMessage } from "@dembrane/billing";
import { canvasWorker } from "@dembrane/canvas";
import type { Config } from "@dembrane/config";
import { conversationWorker, liveRecordings, type PipelineDeps } from "@dembrane/conversations";
import type { Db } from "@dembrane/db";
import {
  supportContent,
  supportForwardRegistration,
  supportInboxMessage,
  supportOutbox,
} from "@dembrane/feedback";
import {
  type Completer,
  type Embedder,
  embeddingLocationOf,
  embeddingModelOf,
  type Models,
} from "@dembrane/llm";
import type { Mailer } from "@dembrane/mail";
import { mapWorker } from "@dembrane/map";
import { audiences, Notifier } from "@dembrane/notifications";
import type { Logger } from "@dembrane/observability";
import {
  finishReads,
  type PopcornWorkerDeps,
  popcornAllowance,
  popcornDeckHook,
  popcornFlags,
  popcornProjectNudge,
  popcornWorker,
  runPopcornTick,
  runtimeAnalysis,
  tickDeps,
} from "@dembrane/popcorn";
import { presentAdoption } from "@dembrane/present";
import {
  bookingInboxMessage,
  environmentName,
  httpForwarder,
  pricingRegistration,
  pricingStorage,
} from "@dembrane/pricing";
import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { PostgresRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { reportsWorker } from "@dembrane/reports";
import { MILLBROOK_IDS, samplesWorker } from "@dembrane/samples";
import type { ObjectStorage } from "@dembrane/storage";
import { type JobSink, tenancyWorker } from "@dembrane/tenancy";
import {
  dispatchWebhook,
  httpDeliver,
  httpSamInbox,
  runDispatch,
  type SamMessage,
  samInboxForwarder,
  samInboxRegistration,
  webhooksStorage,
} from "@dembrane/webhooks";
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
    | "samInbox"
    | "samples"
  >;
  /** Sends the email jobs enqueue. */
  mailer: Mailer;
  /** Lets a job enqueue follow-up jobs (the support timers send email). */
  jobs: JobSink;
  /** The same, with run ids: an account check-in is asked once per task and due time. */
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
  /** Offer PDFs of demos made in echo, and the signed copies emailed with their attachments. */
  files: ObjectStorage;
  /** Runtime database URL with DATABASE_NAME applied, for jobs that open their own connections. */
  databaseUrl: string;
  /** Where the popcorn tick enqueues its workflows and where participant links point. */
  popcorn: { databaseUrl: string; portalUrl: string };
}): Registration[] {
  const { logger, db, config } = deps;
  // Support requests, pricing bookings and overage notices share the team's webhook.
  const teamWebhook =
    config.support.forwardWebhookUrl && config.support.forwardWebhookToken
      ? httpForwarder(config.support.forwardWebhookUrl, config.support.forwardWebhookToken)
      : null;
  // With sam's inbox configured, every message for sam goes there instead, as a queued
  // delivery whose envelope is stored once: the outboxes through a forwarder that names
  // each payload's code, account events and webhooks from their own producers.
  const inboxTarget =
    config.samInbox.url && config.samInbox.secret && config.samInbox.from
      ? { url: config.samInbox.url, secret: config.samInbox.secret, from: config.samInbox.from }
      : null;
  const inboxOpts = { allowPrivate: config.webhooks.allowPrivateTargets };
  const toSam = (toMessage: (payload: Record<string, unknown>) => SamMessage | null) =>
    inboxTarget ? samInboxForwarder(deps.accountsJobs, toMessage) : teamWebhook;
  // SAM_INBOX_SCOPE=support: only support requests take the inbox; the rest keeps its old route.
  const inboxAll = Boolean(inboxTarget) && config.samInbox.scope === "all";
  const toSamAll = (toMessage: (payload: Record<string, unknown>) => SamMessage | null) =>
    inboxAll ? toSam(toMessage) : teamWebhook;
  const analysisDeps = {
    db,
    logger,
    completer: deps.completer,
    embedder: deps.embedder,
    config: {
      embeddingModel: embeddingModelOf(config.llm),
      embeddingLocation: embeddingLocationOf(config.llm),
    },
  };
  const popcornDeps: PopcornWorkerDeps = {
    db,
    logger,
    completer: deps.completer,
    flags: popcornFlags(config),
    participantBaseUrl: deps.popcorn.portalUrl,
    adminBaseUrl: deps.dashboardUrl,
    databaseUrl: deps.popcorn.databaseUrl,
    // A booked read is in: everyone who can open the project hears it, with the reminder
    // to look before the room does.
    notifyReady: async ({ projectId, reportId }) => {
      const people = await audiences(db).projectPeople(projectId);
      await new Notifier(db, logger).emitToAudience(people.userIds, {
        eventCode: "PRESENT_READY",
        title: "Your results are ready to review",
        message: "Take a few minutes to look through them before you present.",
        action: "NAVIGATE_PRESENT",
        refProjectId: projectId,
        refReportId: reportId,
        refWorkspaceId: people.workspaceId,
      });
    },
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
  };
  const company = {
    name: "dembrane B.V.",
    address: config.accounts.companyAddress,
    vat: config.accounts.companyVat,
    kvk: config.accounts.companyKvk,
    iban: config.accounts.bankIban,
    bic: config.accounts.bankBic,
    accountName: config.accounts.bankAccountName,
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
        const inbox = inboxAll ? queue : null;
        await queue.work(dispatchWebhook, { concurrency: 20 }, (p) =>
          runDispatch({ store, deliver, logger, inbox }, p),
        );
      },
    },
    samInboxRegistration({
      post: inboxTarget ? httpSamInbox(inboxTarget, inboxOpts) : null,
      logger,
    }),
    {
      jobs: [sendEmail],
      async register(queue) {
        const loadFile = async (key: string) => {
          const blob = await deps.files.get(key);
          return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
        };
        await queue.work(
          sendEmail,
          { concurrency: 10 },
          emailHandler(deps.mailer, logger, loadFile),
        );
      },
    },
    tenancyWorker(deps),
    // Every workspace's best-practices sample where samples are on, but none in the synthetic
    // demo or preview orgs.
    samplesWorker({
      db,
      logger,
      enabled: config.samples.enabled,
      excludeOrgIds: [DEMO_IDS.org, MILLBROOK_IDS.org],
    }),
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
        forwarder: toSamAll(overageInboxMessage),
        environment: environmentName(deps.dashboardUrl),
      },
    }),
    popcornWorker(popcornDeps),
    supportForwardRegistration({
      outbox: supportOutbox(db),
      forwarder: toSam(supportInboxMessage),
      environment: environmentName(deps.dashboardUrl),
      dashboardUrl: deps.dashboardUrl,
      content: supportContent(config.support.forwardContent, config.support.readUrl),
      logger,
    }),
    pricingRegistration({
      store: pricingStorage(db),
      forwarder: toSamAll(bookingInboxMessage),
      environment: environmentName(deps.dashboardUrl),
      logger,
    }),
    // A finished conversation's transcript books one popcorn read of its project.
    conversationWorker({
      ...deps.conversations,
      onTranscribed: finishReads({
        flags: popcornFlags(config),
        logger,
        free: popcornAllowance(db),
      }),
    }),
    canvasWorker({
      db: deps.db,
      logger,
      completer: deps.completer,
      canvasEnabled: config.canvas.enabled,
    }),
    reportsWorker({ ...deps, portalUrl: deps.popcorn.portalUrl }),
    // The deck view follows the popcorn, tensions and stakeholders publications.
    analysisWorker({ ...analysisDeps, snapshotHooks: [popcornDeckHook(db, logger)] }),
    mapWorker({
      db: deps.db,
      logger,
      completer: deps.completer,
      embedder: deps.embedder,
      config: {
        embeddingModel: embeddingModelOf(config.llm),
        embeddingLocation: embeddingLocationOf(config.llm),
      },
      // A group landing wakes the room, which follows its popcorn session's channel.
      onGroupChanged: popcornProjectNudge(db, logger),
    }),
    accountsWorker({
      db,
      logger,
      jobs: deps.accountsJobs,
      deliver: httpDeliver({ allowPrivate: config.webhooks.allowPrivateTargets }),
      dashboardUrl: deps.dashboardUrl,
      eventsUrl: config.accounts.eventsUrl ?? null,
      eventsSecret: config.accounts.eventsSecret ?? null,
      samInbox: inboxAll,
      offerMessages: config.accounts.offerMessages,
      slackWebhookUrl: config.accounts.slackWebhookUrl ?? null,
      reminderIntervalDays: config.accounts.reminderIntervalDays,
      fetchText: httpFetchText,
      // Demos made in echo: research and authoring on the model groups, the popcorn read
      // run the way an on-request tick runs it.
      demos: (queue) => {
        const analysis = popcornDeps.analysis(queue);
        return {
          db,
          access: new Access(new DrizzleAccessStore(db)),
          staffAudit: new DrizzleStaffAudit(db),
          jobs: queueJobs(queue),
          files: deps.files,
          logger,
          limiter: new RateLimiter(new PostgresRateCounter(db)),
          now: () => new Date(),
          fetchText: httpFetchText,
          settings: {
            dashboardUrl: deps.dashboardUrl,
            company,
            eventsEnabled: Boolean(config.accounts.eventsUrl),
            slackEnabled: Boolean(config.accounts.slackWebhookUrl),
            samInbox: inboxAll,
            offerMessages: config.accounts.offerMessages,
            reminderIntervalDays: config.accounts.reminderIntervalDays,
            // Demo builds send no invite links; publishing (in the API) does.
            inviteSecret: "",
          },
          completer: deps.completer,
          get: demoHttpGet(config.webhooks.allowPrivateTargets),
          // The read acts as the demo's contact, who is held until staff release them.
          extract: async (loopId, runId) =>
            (
              await runPopcornTick(
                { ...tickDeps(popcornDeps, runId, analysis), access: demoBuildAccess(db) },
                loopId,
                "manual",
                runId,
              )
            ).status,
          demo: {
            portalUrl: deps.popcorn.portalUrl,
            apiUrl: config.http.publicUrl,
            workspaceId: config.accounts.demoWorkspaceId ?? null,
            feedbackUrl: config.accounts.demoFeedbackUrl,
          },
        };
      },
    }),
    agenticWorker({
      db,
      logger,
      config,
      databaseUrl: deps.databaseUrl,
      models: deps.models,
    }),
  ];
}
