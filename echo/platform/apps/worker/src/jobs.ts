import { emailHandler, reconcileAccountSeats, reconcileHandler, sendEmail } from "@echo/account";
import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
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

/** What job handlers may use; built once in main.ts. */
export interface WorkerDeps {
  readonly db: Db;
  readonly mailer: Mailer;
}

/** Every job this worker runs. Namespaces add their registration here as they move over. */
export function registrations(logger: Logger, deps: WorkerDeps): Registration[] {
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
