import { emailHandler, sendEmail } from "@echo/account";
import { type Billing, billingRegistration } from "@echo/billing";
import type { Config } from "@echo/config";
import { conversationWorker, liveRecordings, type PipelineDeps } from "@echo/conversations";
import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { environmentName, httpForwarder, pricingRegistration, pricingStorage } from "@echo/pricing";
import {
  createLibrary,
  createView,
  projectsStorage,
  runCreateLibrary,
  runCreateView,
} from "@echo/projects";
import { defineJob, type JobDefinition, type Queue } from "@echo/queue";
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
  config: Pick<Config, "webhooks" | "billing" | "support">;
  /** Sends the email jobs enqueue. */
  mailer: Mailer;
  /** Lets a job enqueue follow-up jobs (the support timers send email). */
  jobs: JobSink;
  /** Where email buttons point. */
  dashboardUrl: string;
  /** Mollie, the billing store and its notifier, shared by the billing jobs. */
  billing: Billing;
  /** The conversation pipeline: storage, media, transcription and models. */
  conversations: PipelineDeps;
}): Registration[] {
  const { logger, db, config } = deps;
  // Pricing bookings and overage notices share the team's webhook.
  const teamWebhook =
    config.support.forwardWebhookUrl && config.support.forwardWebhookToken
      ? httpForwarder(config.support.forwardWebhookUrl, config.support.forwardWebhookToken)
      : null;
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
      jobs: [createLibrary, createView],
      async register(queue) {
        const store = projectsStorage(db);
        await queue.work(createLibrary, { concurrency: 4 }, (p) =>
          runCreateLibrary({ store, logger }, p),
        );
        await queue.work(createView, { concurrency: 4 }, (p) =>
          runCreateView({ store, logger }, p),
        );
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
    pricingRegistration({
      store: pricingStorage(db),
      forwarder: teamWebhook,
      environment: environmentName(deps.dashboardUrl),
      logger,
    }),
    conversationWorker(deps.conversations),
  ];
}
