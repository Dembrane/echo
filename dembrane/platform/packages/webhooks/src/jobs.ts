import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition } from "@dembrane/queue";
import { z } from "zod";
import type { Deliver } from "./deliver";
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

export const webhookJobs: readonly JobDefinition[] = [dispatchWebhook];

export class RetryableDeliveryError extends Error {}

/**
 * 2xx is done; 4xx is the receiver refusing, logged and not retried; anything else,
 * including network errors, throws so the queue retries.
 */
export async function runDispatch(
  deps: { store: WebhooksStorage; deliver: Deliver; logger: Logger },
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
