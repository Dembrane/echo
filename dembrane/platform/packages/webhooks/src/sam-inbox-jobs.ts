import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Payload, type Queue } from "@dembrane/queue";
import { z } from "zod";
import type { Delivery } from "./deliver";
import {
  postSamEnvelope,
  type SamEnvelope,
  SamInboxError,
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

/**
 * A message sam refused, or one that could not be made into a message at all. The run
 * fails on purpose and is never retried: it stays in the queue as failed, counted by the
 * queue health alerts, with the envelope and the reason in its payload. Replaying it is
 * enqueueing deliverSamMessage with that envelope once the cause is fixed.
 */
export const quarantineSamMessage = defineJob(
  "webhooks.sam-inbox-quarantine",
  z.object({
    code: z.string().nullable(),
    id: z.string(),
    body: z.string(),
    reason: z.string(),
    status: z.number().nullable(),
  }),
  { retryLimit: 0, expireInSeconds: 60 },
);

export type Quarantined = z.input<typeof quarantineSamMessage.schema>;

/** The queue as a producer sees it: inside its transaction where it has one, with run ids. */
export interface SamQueue<T = never> {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: { tx?: T; workflowId?: string },
  ): Promise<unknown>;
}

/**
 * The run id of a message: one run per (code, id). Enqueueing the same message again
 * returns the first run, so a repeated event or a re-run outbox sends the bytes stored the
 * first time instead of a rebuilt body sam would refuse as a conflict.
 */
export const samRunId = (code: string, id: string) => `sam-inbox:${code}:${id}`;

async function quarantine<T>(sink: SamQueue<T>, q: Quarantined, tx?: T): Promise<void> {
  await sink.enqueue(quarantineSamMessage, q, {
    ...(tx !== undefined && { tx }),
    ...(q.id && { workflowId: `sam-inbox-quarantine:${q.code ?? "none"}:${q.id}` }),
  });
}

/**
 * Serialises the message now and queues its delivery under its run id. A message sam
 * would refuse for its size or code is quarantined instead, so it is kept and visible.
 */
export async function enqueueSamMessage<T>(
  sink: SamQueue<T>,
  message: SamMessage,
  opts: { tx?: T } = {},
): Promise<void> {
  let envelope: SamEnvelope;
  try {
    envelope = samEnvelope(message);
  } catch (err) {
    if (!(err instanceof SamInboxError)) throw err;
    await quarantine(
      sink,
      {
        code: message.code,
        id: message.id,
        body: JSON.stringify(message.json),
        reason: err.message,
        status: null,
      },
      opts.tx,
    );
    return;
  }
  await sink.enqueue(deliverSamMessage, envelope, {
    ...(opts.tx !== undefined && { tx: opts.tx }),
    workflowId: samRunId(envelope.code, envelope.id),
  });
}

/** The shape the scheduled outboxes (support, pricing bookings, overage notices) post through. */
export interface OutboxForwarder {
  post(payload: Record<string, unknown>): Promise<Delivery>;
}

/**
 * Puts sam's inbox behind an outbox's forwarder. Each payload is queued as a delivery,
 * its envelope persisted under its run id, and answered 202 so the outbox stamps the row:
 * retries then resend the stored bytes instead of a body rebuilt from rows that changed,
 * and a refusal is quarantined in the queue instead of holding a place in the outbox's
 * oldest-first batch. A payload `toMessage` cannot name is quarantined the same way.
 */
export function samInboxForwarder<T>(
  sink: SamQueue<T>,
  toMessage: (payload: Record<string, unknown>) => SamMessage | null,
): OutboxForwarder {
  return {
    async post(payload) {
      const message = toMessage(payload);
      if (message) await enqueueSamMessage(sink, message);
      else
        await quarantine(sink, {
          code: null,
          id: String(payload.id ?? payload.booking_uid ?? ""),
          body: JSON.stringify(payload),
          reason: "no sam inbox code for this payload",
          status: null,
        });
      return { status: 202, text: "queued for sam's inbox" };
    },
  };
}

/** Sends one stored envelope once; a fake stands in for it in tests. */
export type PostSamEnvelope = (envelope: SamEnvelope) => Promise<Delivery>;

export function httpSamInbox(target: SamInboxTarget, opts: SamInboxOptions): PostSamEnvelope {
  return (envelope) => postSamEnvelope(target, envelope, opts);
}

/**
 * 2xx is done. A refusal is quarantined with its envelope and the answer: sending it
 * again cannot change sam's answer, and the quarantine run keeps it failed and visible.
 * Busy, down or unreachable throws, so the queue retries with a fresh signature. With the
 * inbox unconfigured the run fails the same way, so messages queued before a config change
 * wait for it instead of vanishing.
 */
export async function runDeliverSamMessage(
  d: {
    post: PostSamEnvelope | null;
    logger: Logger;
    quarantine: (q: Quarantined) => Promise<void>;
  },
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
      "sam inbox refused the message; quarantined, not retrying",
    );
    await d.quarantine({
      ...p,
      reason: `sam answered ${res.status}: ${res.text.slice(0, 200)}`,
      status: res.status,
    });
    return;
  }
  throw new SamInboxRetry(`sam inbox answered ${res.status}`);
}

export class SamInboxQuarantined extends Error {}

/** Fails the quarantine run on purpose, so it ends failed with its payload kept. */
export async function runQuarantineSamMessage(
  d: { logger: Logger },
  p: z.output<typeof quarantineSamMessage.schema>,
): Promise<never> {
  d.logger.error(
    { code: p.code, id: p.id, status: p.status, signal: "sam_inbox.quarantined" },
    "sam inbox message quarantined",
  );
  throw new SamInboxQuarantined(`${p.code ?? "no code"} ${p.id}: ${p.reason}`);
}

/** The worker's registration. Deliveries wait on sam, so several run at once. */
export function samInboxRegistration(d: { post: PostSamEnvelope | null; logger: Logger }) {
  return {
    jobs: [deliverSamMessage, quarantineSamMessage],
    async register(queue: Queue) {
      const toQuarantine = (q: Quarantined) => quarantine(queue as SamQueue<never>, q);
      await queue.work(deliverSamMessage, { concurrency: 5 }, (p) =>
        runDeliverSamMessage({ ...d, quarantine: toQuarantine }, p),
      );
      await queue.work(quarantineSamMessage, { concurrency: 1 }, async (p) => {
        await runQuarantineSamMessage(d, p);
      });
    },
  };
}

/**
 * Records jobs instead of queueing them; for tests. Honours run ids as the queue does: a
 * second enqueue under the same id keeps the first payload.
 */
export class MemorySamQueue implements SamQueue<unknown> {
  readonly jobs: { name: string; payload: unknown; tx?: unknown; workflowId?: string }[] = [];
  async enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts: { tx?: unknown; workflowId?: string } = {},
  ) {
    if (opts.workflowId && this.jobs.some((j) => j.workflowId === opts.workflowId)) return;
    this.jobs.push({
      name: def.name,
      payload: def.schema.parse(payload),
      ...(opts.tx !== undefined && { tx: opts.tx }),
      ...(opts.workflowId && { workflowId: opts.workflowId }),
    });
  }
  of<T = Record<string, unknown>>(name: string): T[] {
    return this.jobs.filter((j) => j.name === name).map((j) => j.payload as T);
  }
}
