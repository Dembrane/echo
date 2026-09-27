import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { defineJob } from "@echo/queue";
import { z } from "zod";
import { type EmailTemplate, render } from "./emails";
import { reconcileSeats } from "./seats";

/**
 * One transactional email. Rendered in the worker so the request that caused it returns
 * before SendGrid answers; a refused send throws and pg-boss retries it.
 */
export const sendEmail = defineJob(
  "account.send-email",
  z.object({
    to: z.string(),
    subject: z.string(),
    template: z.string(),
    data: z.record(z.string(), z.string()),
    /** What the email was for, in the logs of a failed attempt. */
    context: z.string(),
  }),
  { retryLimit: 3, retryDelaySeconds: 30, expireInSeconds: 120 },
);

/**
 * Brings an account's billing in line with its live seat count after a seat was taken.
 * Enqueued only for active paid accounts; idempotent, and keyed per account so a burst of
 * accepts collapses into one run.
 */
export const reconcileAccountSeats = defineJob(
  "billing.reconcile-seats",
  z.object({ accountId: z.string() }),
  { policy: "singleton", retryLimit: 3, expireInSeconds: 300 },
);

export function emailHandler(mailer: Mailer, logger: Logger) {
  return async (p: z.output<typeof sendEmail.schema>) => {
    const { html, text } = render({ template: p.template, data: p.data } as EmailTemplate);
    try {
      await mailer.send({ to: p.to, subject: p.subject, html, text, tags: [p.template] });
    } catch (err) {
      logger.error(
        { err, context: p.context, template: p.template },
        "email send failed, will retry",
      );
      throw err;
    }
  };
}

export function reconcileHandler(db: Db, logger: Logger) {
  return async (p: z.output<typeof reconcileAccountSeats.schema>) => {
    await reconcileSeats(db, p.accountId, logger);
  };
}
