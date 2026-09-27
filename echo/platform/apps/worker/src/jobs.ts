import { type Billing, billingRegistration } from "@echo/billing";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { environmentName, httpForwarder, pricingRegistration, pricingStorage } from "@echo/pricing";
import { defineJob, type JobDefinition, type Queue } from "@echo/queue";
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

/** What job handlers are built from; made once in main.ts. */
export interface WorkerDeps {
  readonly logger: Logger;
  readonly config: Config;
  readonly mailer: Mailer;
  readonly billing: Billing;
  readonly db: Db;
}

/** Every job this worker runs. Namespaces add their registration here as they move over. */
export function registrations(deps: WorkerDeps): Registration[] {
  const { logger } = deps;
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
    billingRegistration({
      billing: deps.billing,
      mailer: deps.mailer,
      logger,
      customerJobs: deps.config.billing.customerJobs === "on",
      dashboardUrl: deps.config.http.dashboardUrl,
    }),
    pricingRegistration({
      store: pricingStorage(deps.db),
      forwarder:
        deps.config.support.forwardWebhookUrl && deps.config.support.forwardWebhookToken
          ? httpForwarder(
              deps.config.support.forwardWebhookUrl,
              deps.config.support.forwardWebhookToken,
            )
          : null,
      environment: environmentName(deps.config.http.dashboardUrl),
      logger,
    }),
  ];
}
