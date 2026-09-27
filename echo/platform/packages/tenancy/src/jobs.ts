import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { defineJob, type JobDefinition, type Payload, type Queue } from "@echo/queue";
import type postgres from "postgres";
import { z } from "zod";
import type { Conn } from "./db";
import type { TenancyDeps } from "./deps";
import { expireOverdueSupportMemberships, runDueScheduledTasks } from "./scheduled";

/** One rendered email. Retried by the queue until SendGrid accepts it. */
export const emailJob = defineJob(
  "tenancy.email",
  z.object({
    to: z.union([z.string(), z.array(z.string())]),
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    tags: z.array(z.string()).optional(),
  }),
  { retryLimit: 3, retryDelaySeconds: 15 },
);

/**
 * A workspace's seats changed, so its billing account must be re-priced. Billing owns the
 * handler (Mollie re-price and proration); this namespace only produces the job, in the
 * transaction that changed the seats, so no seat change goes unbilled.
 */
export const reconcileSeatsJob = defineJob(
  "billing.reconcile-account-seats",
  z.object({ accountId: z.string() }),
  { retryLimit: 5 },
);

/** Every minute: run the due one-shot rows of scheduled_task this namespace owns. */
export const scheduledTasksJob = defineJob("tenancy.scheduled-tasks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** Every 15 minutes: end staff support grants whose 24 hours passed but whose revoke row was lost. */
export const expireSupportJob = defineJob("tenancy.expire-staff-support", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** The jobs the API enqueues; its queue client creates exactly these. */
export const tenancyApiJobs: readonly JobDefinition[] = [emailJob, reconcileSeatsJob];

/**
 * Enqueues a job inside the caller's transaction, so a job exists only if the write that
 * caused it committed.
 */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: { tx?: Conn; startAfter?: Date },
  ): Promise<void>;
}

/** The postgres.js handle under a Drizzle pool or transaction. */
function rawSql(conn: Conn): postgres.Sql | postgres.TransactionSql {
  return (conn as unknown as { session: { client: postgres.Sql | postgres.TransactionSql } })
    .session.client;
}

export function queueSink(queue: Pick<Queue, "enqueue">): JobSink {
  return {
    async enqueue(def, payload, opts = {}) {
      await queue.enqueue(def, payload, {
        ...(opts.tx && { tx: rawSql(opts.tx) }),
        ...(opts.startAfter && { startAfter: opts.startAfter }),
      });
    },
  };
}

/** Records jobs instead of queueing them; for tests. */
export class MemoryJobSink implements JobSink {
  readonly jobs: { name: string; payload: unknown }[] = [];
  async enqueue<J extends JobDefinition>(def: J, payload: Payload<J>) {
    this.jobs.push({ name: def.name, payload: def.schema.parse(payload) });
  }
}

/** What the worker needs to run this namespace's jobs. */
export interface TenancyWorkerDeps extends Pick<TenancyDeps, "db" | "jobs" | "dashboardUrl"> {
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function tenancyWorker(deps: TenancyWorkerDeps) {
  const jobs: JobDefinition[] = [emailJob, scheduledTasksJob, expireSupportJob];
  return {
    jobs,
    async register(queue: Queue) {
      await queue.work(emailJob, { concurrency: 5 }, async (msg) => {
        await deps.mailer.send({
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(msg.tags && { tags: msg.tags }),
        });
      });
      await queue.work(scheduledTasksJob, { concurrency: 1 }, async () => {
        const done = await runDueScheduledTasks(deps);
        if (done) deps.logger.info({ tasks: done }, "scheduled tasks processed");
      });
      await queue.work(expireSupportJob, { concurrency: 1 }, async () => {
        const n = await expireOverdueSupportMemberships(deps);
        if (n) deps.logger.info({ memberships: n }, "overdue staff support ended");
      });
      await queue.schedule(scheduledTasksJob, "* * * * *", {});
      await queue.schedule(expireSupportJob, "*/15 * * * *", {});
    },
  };
}
