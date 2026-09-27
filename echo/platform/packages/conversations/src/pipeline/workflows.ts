import { type StepConfig, step } from "@echo/queue";
import {
  claimFinalize,
  claimFinish,
  handOver,
  loadChunk,
  mergeAudio,
  type PipelineDeps,
  prepareChunk,
  stampOverCap,
  summarize,
  summarizedWebhook,
  transcribePiece,
  updateChunk,
  warmTokenCount,
} from "./steps";

type Retry = Omit<StepConfig, "name">;

/** How often each kind of step is retried. Tests shorten the intervals. */
export interface RetryPolicy {
  /** Every attempt re-sends the audio to Gemini: five retries, 30 s doubling (about fifteen minutes). */
  readonly transcribe: Retry;
  /** ffmpeg on the media service: a killed instance or a network blip. */
  readonly media: Retry;
  /** The summary call and its writes. */
  readonly llm: Retry;
  /** Plain database steps: a dropped connection or a failover. */
  readonly db: Retry;
}

export const RETRIES: RetryPolicy = {
  transcribe: { retriesAllowed: true, maxAttempts: 6, intervalSeconds: 30, backoffRate: 2 },
  media: { retriesAllowed: true, maxAttempts: 8, intervalSeconds: 15, backoffRate: 2 },
  llm: { retriesAllowed: true, maxAttempts: 6, intervalSeconds: 15, backoffRate: 2 },
  db: { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 },
};

// Names a run's merged file, so a retried merge overwrites the file it wrote before.
const RUN_NAMESPACE = "2f7c6b1e-3d4a-4e8f-9b0c-1a2b3c4d5e6f";

/**
 * The conversation pipeline as durable workflows (ADR 0007), replacing the five-phase
 * Dramatiq saga and the crons that repaired it. Each side effect is a step whose result
 * DBOS checkpoints; after a crash a run resumes at its first unfinished step on any
 * worker. The steps and why each is safe to run twice are in README.md.
 */
export function pipelineWorkflows(d: PipelineDeps, retry: RetryPolicy = RETRIES) {
  return {
    /** conversations.chunk: load, convert and split, transcribe each piece, hand over. */
    async chunk(p: { chunkId: string; usePiiRedaction: boolean }): Promise<void> {
      const loaded = await step("load", () => loadChunk(d, p.chunkId), retry.db);
      const conversationId = loaded.conversationId;
      if (!conversationId) return;
      if (!loaded.skip) {
        let pieces: string[] = [];
        try {
          pieces = await step("prepare", () => prepareChunk(d, p.chunkId), retry.media);
        } catch (err) {
          // Out of retries. The Python left such a chunk pending forever, which kept its
          // conversation from ever finalizing; marking it lets the rest go through.
          const message = (err as Error).message;
          await step(
            "prepare-failed",
            () => updateChunk(d, p.chunkId, conversationId, { error: message }, false),
            retry.db,
          );
        }
        for (const piece of pieces) {
          try {
            await step(
              "transcribe",
              () =>
                transcribePiece(d, piece, {
                  usePiiRedaction: p.usePiiRedaction,
                  anonymize: loaded.anonymize,
                }),
              retry.transcribe,
            );
          } catch {
            // Out of retries: the last attempt saved its error on the chunk, which is
            // what makes it count as done rather than pending.
          }
        }
      }
      await step("hand-over", () => handOver(d, conversationId), retry.db);
    },

    /** conversations.finish: claim, stamp the cap, hand over. */
    async finish(p: { conversationId: string }): Promise<void> {
      const claimed = await step("claim", () => claimFinish(d, p.conversationId), retry.db);
      if (!claimed) return;
      await step("stamp-over-cap", () => stampOverCap(d, p.conversationId), retry.db);
      await step("hand-over", () => handOver(d, p.conversationId), retry.db);
    },

    /** conversations.finalize: claim (and the transcribed webhook), merge, summarise, count. */
    async finalize(p: { conversationId: string }, runId: string): Promise<void> {
      const projectId = await step("claim", () => claimFinalize(d, p.conversationId), retry.db);
      if (!projectId) return;
      const run = Bun.randomUUIDv5(runId, RUN_NAMESPACE);
      try {
        await step("merge", () => mergeAudio(d, p.conversationId, run), retry.media);
      } catch (err) {
        // The merged file is also built on demand when a host plays the conversation.
        d.logger.warn(
          { conversationId: p.conversationId, err: (err as Error).message },
          "merge gave up",
        );
      }
      await summarizeWithWebhook(d, p.conversationId, retry);
      await step("token-count", () => warmTokenCount(d, p.conversationId), retry.db);
    },

    /** conversations.summarize: the catch-up for a summary that failed or was locked. */
    async summarize(p: { conversationId: string }): Promise<void> {
      await summarizeWithWebhook(d, p.conversationId, retry);
    },
  };
}

async function summarizeWithWebhook(d: PipelineDeps, conversationId: string, retry: RetryPolicy) {
  let wrote = false;
  try {
    wrote = await step("summarize", () => summarize(d, conversationId), retry.llm);
  } catch (err) {
    // The summary catch-up picks it up again in five minutes.
    d.logger.warn({ conversationId, err: (err as Error).message }, "summary gave up");
  }
  if (wrote) await step("summarized-webhook", () => summarizedWebhook(d, conversationId), retry.db);
}
