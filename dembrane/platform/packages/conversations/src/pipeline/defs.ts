import { defineJob } from "@dembrane/queue";
import { z } from "zod";

/**
 * The conversation pipeline's durable workflows and schedules. The API enqueues them in
 * the transaction that causes them; the worker runs them. See pipeline/README.md for the
 * steps and why each is safe to run twice.
 */

// A participant's recording waits on these runs, so recovery resumes them far more often
// than the default before it sets one aside. The cost: a run that cannot finish is resumed
// that many times, each on another worker, before it is left for a person.
const LOST_WORKER_LIMIT = 10;

/**
 * One uploaded chunk: convert, split, transcribe each piece, hand over to finalize. A typed
 * chunk of an anonymised conversation is marked here; its raw text waits in the row's
 * pending_text, never in a job input or step output, which the queue keeps.
 */
export const processChunk = defineJob(
  "conversations.chunk",
  z.object({
    chunkId: z.string(),
    usePiiRedaction: z.boolean().default(false),
    typed: z.boolean().optional(),
  }),
  // Retries live on the steps; this bounds one run (Vertex outages back off for minutes).
  { retryLimit: 0, expireInSeconds: 6 * 3600, lostWorkerLimit: LOST_WORKER_LIMIT },
);

/** The participant (or the idle sweep) finished: mark it, stamp the cap, maybe finalize. */
export const finishConversation = defineJob(
  "conversations.finish",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 3600, lostWorkerLimit: LOST_WORKER_LIMIT },
);

/** Every chunk is transcribed and the conversation is finished: flag, merge, summarise, count. */
export const finalizeConversation = defineJob(
  "conversations.finalize",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 6 * 3600, lostWorkerLimit: LOST_WORKER_LIMIT },
);

/** A summary on its own: the catch-up for conversations unlocked by an upgrade. */
export const summarizeConversation = defineJob(
  "conversations.summarize",
  z.object({ conversationId: z.string() }),
  { retryLimit: 0, expireInSeconds: 3600, lostWorkerLimit: LOST_WORKER_LIMIT },
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

/** Every five minutes: rerun, or give up, chunk runs that ended without a result. */
export const releaseStrandedChunkRuns = defineJob("conversations.stranded-chunks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 300,
});
