import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { defineJob } from "@dembrane/queue";
import { z } from "zod";
import { type EmailTemplate, render } from "./emails";

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
