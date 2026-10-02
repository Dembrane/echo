import type { Logger } from "@dembrane/observability";
import { defineJob, type Queue } from "@dembrane/queue";
import { z } from "zod";
import type { Delivery } from "./deliver";
import {
  postSamEnvelope,
  type SamEnvelope,
  type SamInboxOptions,
  type SamInboxTarget,
  type SamMessage,
  samEnvelope,
  samOutcome,
} from "./sam-inbox";

/** Thrown so the queue tries again: sam busy, down, unreachable or not yet configured. */
export class SamInboxRetry extends Error {}

/**
 * One message to sam's inbox. The payload is the serialised envelope, written when the
 * event happens, so every retry sends the same bytes under the same id. Six retries
 * backing off from ten seconds cover a sam restart; a run that exhausts them stays in the
 * queue as failed, its envelope intact for a replay.
 */
export const deliverSamMessage = defineJob(
  "webhooks.sam-inbox",
  z.object({ code: z.string(), id: z.string(), body: z.string() }),
  { retryLimit: 6, retryDelaySeconds: 10, retryBackoff: true, expireInSeconds: 120 },
);

/** Enqueues the way the producer's own sink does: inside its transaction where it has one. */
export interface SamMessageSink<O> {
  enqueue(def: typeof deliverSamMessage, payload: SamEnvelope, opts?: O): Promise<unknown>;
}

/** Serialises the message now and queues its delivery. */
export async function enqueueSamMessage<O>(
  sink: SamMessageSink<O>,
  message: SamMessage,
  opts?: O,
): Promise<void> {
  await sink.enqueue(deliverSamMessage, samEnvelope(message), opts);
}

/** Sends one stored envelope once; a fake stands in for it in tests. */
export type PostSamEnvelope = (envelope: SamEnvelope) => Promise<Delivery>;

export function httpSamInbox(target: SamInboxTarget, opts: SamInboxOptions): PostSamEnvelope {
  return (envelope) => postSamEnvelope(target, envelope, opts);
}

/**
 * 2xx is done. A refusal is logged with the run's id and left for a replay: sending it
 * again cannot change sam's answer. Busy, down or unreachable throws, so the queue retries
 * with a fresh signature. With the inbox unconfigured the run fails the same way, so
 * messages queued before a config change wait for it instead of vanishing.
 */
export async function runDeliverSamMessage(
  d: { post: PostSamEnvelope | null; logger: Logger },
  p: SamEnvelope,
): Promise<void> {
  if (!d.post) throw new SamInboxRetry("sam inbox is not configured");
  const res = await d.post(p);
  const outcome = samOutcome(res.status);
  if (outcome === "delivered") {
    d.logger.info({ code: p.code, id: p.id, status: res.status }, "sam inbox message delivered");
    return;
  }
  if (outcome === "permanent") {
    d.logger.error(
      {
        code: p.code,
        id: p.id,
        status: res.status,
        body: res.text.slice(0, 200),
        signal: "sam_inbox.refused",
      },
      "sam inbox refused the message; its run keeps the envelope for a replay, not retrying",
    );
    return;
  }
  throw new SamInboxRetry(`sam inbox answered ${res.status}`);
}

/** The worker's registration. Deliveries wait on sam, so several run at once. */
export function samInboxRegistration(d: { post: PostSamEnvelope | null; logger: Logger }) {
  return {
    jobs: [deliverSamMessage],
    async register(queue: Queue) {
      await queue.work(deliverSamMessage, { concurrency: 5 }, (p) => runDeliverSamMessage(d, p));
    },
  };
}
