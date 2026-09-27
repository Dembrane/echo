import { emailHandler, reconcileAccountSeats, reconcileHandler, sendEmail } from "@echo/account";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import {
  createLibrary,
  createView,
  projectsStorage,
  runCreateLibrary,
  runCreateView,
} from "@echo/projects";
import { defineJob, type JobDefinition, type Queue } from "@echo/queue";
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

/** What job handlers may use; built once in main.ts. */

/** Every job this worker runs. Namespaces add their registration here as they move over. */
/** What the worker's jobs need, built once in main.ts. */
export interface WorkerDeps {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly config: Pick<Config, "webhooks">;
}

export function registrations(logger: Logger, deps: WorkerDeps): Registration[] {
  const { db, config } = deps;
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
      jobs: [sendEmail, reconcileAccountSeats],
      async register(queue) {
        await queue.work(sendEmail, { concurrency: 10 }, emailHandler(deps.mailer, logger));
        await queue.work(
          reconcileAccountSeats,
          { concurrency: 2 },
          reconcileHandler(deps.db, logger),
        );
      },
    },
  ];
}
