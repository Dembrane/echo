import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition } from "@dembrane/queue";
import { z } from "zod";
import type { Deliver } from "./deliver";
import { inboxCodeOf } from "./sam-inbox";
import {
  deliverSamMessage,
  enqueueSamMessage,
  quarantineSamMessage,
  SamInboxRetry,
  type SamQueue,
} from "./sam-inbox-jobs";
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
export const webhookJobs: readonly JobDefinition[] = [
  dispatchWebhook,
  deliverSamMessage,
  quarantineSamMessage,
];

export class RetryableDeliveryError extends Error {}

/**
 * 2xx is done; 4xx is the receiver refusing, logged and not retried; anything else,
 * including network errors, throws so the queue retries. A webhook staff aimed at sam's
 * inbox queues the same payload for the inbox instead (see dispatchToInbox).
 */
export async function runDispatch(
  deps: {
    store: WebhooksStorage;
    deliver: Deliver;
    logger: Logger;
    /** Queues inbox deliveries; null when SAM_INBOX_* is unset. */
    inbox?: SamQueue | null;
  },
  p: z.output<typeof dispatchWebhook.schema>,
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
  if (code) return dispatchToInbox(deps, { id: hook.id, code }, p.payload);
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

/**
 * The event's own identity, as the legacy receiver deduplicated it: the conversation (or
 * report) and the event. The same event queued again maps to the same message.
 */
export function webhookMessageId(payload: Record<string, unknown>): string | null {
  const subject = (payload.conversation ?? payload.report) as { id?: unknown } | undefined;
  return subject?.id && payload.event ? `${String(subject.id)}:${String(payload.event)}` : null;
}

/**
 * Queues the payload as one inbox message under the event's id. A later enqueue of the
 * same event (a re-run pipeline step) returns the first run, so sam gets the body stored
 * the first time and never a rebuilt one with a new timestamp under the same id.
 */
async function dispatchToInbox(
  deps: { logger: Logger; inbox?: SamQueue | null },
  hook: { id: string; code: string },
  payload: Record<string, unknown>,
): Promise<void> {
  // Unconfigured: fail the run so it waits for the config instead of vanishing.
  if (!deps.inbox) throw new SamInboxRetry("sam inbox is not configured");
  const id = webhookMessageId(payload);
  if (!id) throw new Error(`webhook ${hook.id}: payload has no conversation or report id`);
  await enqueueSamMessage(deps.inbox, { code: hook.code, json: payload, id });
  deps.logger.info({ webhook_id: hook.id, code: hook.code, id }, "webhook queued for sam");
}
