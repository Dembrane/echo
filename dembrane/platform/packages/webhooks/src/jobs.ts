import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition } from "@dembrane/queue";
import { z } from "zod";
import type { Deliver } from "./deliver";
import { inboxCodeOf, samEnvelope, samOutcome } from "./sam-inbox";
import { deliverSamMessage, type PostSamEnvelope, SamInboxRetry } from "./sam-inbox-jobs";
import type { WebhooksStorage } from "./storage";

/**
 * One webhook POST. The payload is built when the event happens, so a retry sends the
 * same body; the webhook's URL and secret are read at send time, so an edit or an unpublish
 * in between wins. Three retries, backing off from five seconds.
 */
export const dispatchWebhook = defineJob(
  "webhooks.dispatch",
  z.object({ webhookId: z.string(), payload: z.record(z.string(), z.unknown()) }),
  { retryLimit: 3, retryDelaySeconds: 5, retryBackoff: true, expireInSeconds: 120 },
);

/** The jobs the API enqueues; its queue client creates exactly these. */
export const webhookJobs: readonly JobDefinition[] = [dispatchWebhook, deliverSamMessage];

export class RetryableDeliveryError extends Error {}

/**
 * 2xx is done; 4xx is the receiver refusing, logged and not retried; anything else,
 * including network errors, throws so the queue retries. A webhook staff aimed at sam's
 * inbox sends the same payload there instead, under the run's id, which a retry keeps.
 */
export async function runDispatch(
  deps: {
    store: WebhooksStorage;
    deliver: Deliver;
    logger: Logger;
    /** sam's inbox; null when SAM_INBOX_* is unset. */
    inbox?: PostSamEnvelope | null;
  },
  p: z.output<typeof dispatchWebhook.schema>,
  job?: { id: string },
): Promise<void> {
  const hook = await deps.store.get(p.webhookId);
  if (!hook) {
    deps.logger.warn({ webhook_id: p.webhookId }, "webhook not found, skipping");
    return;
  }
  if (hook.status !== "published") {
    deps.logger.info({ webhook_id: p.webhookId }, "webhook not published, skipping");
    return;
  }
  const code = inboxCodeOf(hook.url);
  if (code) return dispatchToInbox(deps, { id: hook.id, code }, p.payload, job);
  const res = await deps.deliver(
    { id: hook.id, name: hook.name, url: hook.url, secret: hook.secret },
    p.payload,
  );
  if (res.status >= 200 && res.status < 300) {
    deps.logger.info({ webhook_id: hook.id, status: res.status }, "webhook delivered");
    return;
  }
  if (res.status >= 400 && res.status < 500) {
    deps.logger.warn(
      { webhook_id: hook.id, status: res.status, body: res.text.slice(0, 200) },
      "webhook refused by receiver, not retrying",
    );
    return;
  }
  throw new RetryableDeliveryError(`Webhook returned status ${res.status}`);
}

async function dispatchToInbox(
  deps: { logger: Logger; inbox?: PostSamEnvelope | null },
  hook: { id: string; code: string },
  payload: Record<string, unknown>,
  job: { id: string } | undefined,
): Promise<void> {
  // Unconfigured: fail the run so it waits for the config instead of vanishing.
  if (!deps.inbox) throw new SamInboxRetry("sam inbox is not configured");
  if (!job) throw new Error("an inbox delivery needs the run's id as its message id");
  const envelope = samEnvelope({ code: hook.code, json: payload, id: job.id });
  const res = await deps.inbox(envelope);
  const outcome = samOutcome(res.status);
  if (outcome === "delivered") {
    deps.logger.info({ webhook_id: hook.id, code: envelope.code }, "webhook delivered to sam");
    return;
  }
  if (outcome === "permanent") {
    deps.logger.error(
      {
        webhook_id: hook.id,
        code: envelope.code,
        id: envelope.id,
        status: res.status,
        body: res.text.slice(0, 200),
        signal: "sam_inbox.refused",
      },
      "sam inbox refused the webhook, not retrying",
    );
    return;
  }
  throw new SamInboxRetry(`sam inbox answered ${res.status}`);
}
