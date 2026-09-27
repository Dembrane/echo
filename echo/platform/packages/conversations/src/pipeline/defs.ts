import { defineJob } from "@echo/queue";
import { z } from "zod";

/**
 * The conversation pipeline's durable workflows and schedules. The API enqueues them in
 * the transaction that causes them; the worker runs them. See pipeline/README.md for the
 * steps and why each is safe to run twice.
 */

/** One uploaded chunk: convert, split, transcribe each piece, hand over to finalize. */
export const processChunk = defineJob(
  "conversations.chunk",
  z.object({ chunkId: z.string(), usePiiRedaction: z.boolean().default(false) }),
  // Retries live on the steps; this bounds one run (Vertex outages back off for minutes).
  { retryLimit: 0, expireInSeconds: 6 * 3600 },
);

/** The participant (or the idle sweep) finished: mark it, stamp the cap, maybe finalize. */
export const finishConversation = defineJob(
  "conversations.finish",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 3600 },
);

/** Every chunk is transcribed and the conversation is finished: flag, merge, summarise, count. */
export const finalizeConversation = defineJob(
  "conversations.finalize",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 6 * 3600 },
);

/** A summary on its own: the catch-up for conversations unlocked by an upgrade. */
export const summarizeConversation = defineJob(
  "conversations.summarize",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 3600 },
);

/** Every two minutes: finish conversations nobody has added to for five minutes. */
export const finishIdleConversations = defineJob("conversations.finish-idle", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 120,
});

/** Every five minutes: summarise transcribed conversations that have none and are not locked. */
export const catchUpSummaries = defineJob("conversations.summary-catch-up", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 300,
});
