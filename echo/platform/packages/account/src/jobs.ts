import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { defineJob } from "@dembrane/queue";
import { z } from "zod";
import { type EmailTemplate, render, subjectOf } from "./emails";

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
    /**
     * The recipient's language (any stored value, see @dembrane/i18n resolveLocale). The
     * subject and body are then worded from the catalog in it; jobs queued before this
     * field existed carry none and render with their English subject, as before.
     */
    language: z.string().optional(),
  }),
  { retryLimit: 3, retryDelaySeconds: 30, expireInSeconds: 120 },
);

export function emailHandler(mailer: Mailer, logger: Logger) {
  return async (p: z.output<typeof sendEmail.schema>) => {
    const template = { template: p.template, data: p.data } as EmailTemplate;
    const { html, text } = render(template, p.language);
    const subject = p.language ? (subjectOf(template, p.language) ?? p.subject) : p.subject;
    try {
      await mailer.send({ to: p.to, subject, html, text, tags: [p.template] });
    } catch (err) {
      logger.error(
        { err, context: p.context, template: p.template },
        "email send failed, will retry",
      );
      throw err;
    }
  };
}
