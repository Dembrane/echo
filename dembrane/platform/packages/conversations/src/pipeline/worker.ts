import type { JobDefinition, Queue } from "@dembrane/queue";
import {
  catchUpSummaries,
  finalizeConversation,
  finalTranscript,
  finishConversation,
  finishIdleConversations,
  processChunk,
  releaseStrandedChunkRuns,
  summarizeConversation,
} from "./defs";
import {
  idleConversations,
  type PipelineDeps,
  releaseStrandedChunks,
  unsummarizedConversations,
} from "./steps";
import { pipelineWorkflows, RETRIES, type RetryPolicy } from "./workflows";

/**
 * The worker's side of the pipeline: the four workflows on their queues and the three
 * schedules that start them. Chunk runs wait on Gemini, so many run at once; the ffmpeg
 * work they hand the media service scales there, not here.
 */
export function conversationWorker(
  d: PipelineDeps,
  opts: { retry?: RetryPolicy; concurrency?: Partial<Record<string, number>> } = {},
): { jobs: readonly JobDefinition[]; register(queue: Queue): Promise<void> } {
  const wf = pipelineWorkflows(d, opts.retry ?? RETRIES);
  const conc = (name: string, fallback: number) => opts.concurrency?.[name] ?? fallback;
  return {
    jobs: [
      processChunk,
      finishConversation,
      finalizeConversation,
      finalTranscript,
      summarizeConversation,
      finishIdleConversations,
      catchUpSummaries,
      releaseStrandedChunkRuns,
    ],
    async register(queue) {
      await queue.workflow(processChunk, { concurrency: conc("chunk", 20) }, (p) => wf.chunk(p));
      await queue.workflow(finishConversation, { concurrency: conc("finish", 10) }, (p) =>
        wf.finish(p),
      );
      await queue.workflow(finalizeConversation, { concurrency: conc("finalize", 10) }, (p, job) =>
        wf.finalize(p, job.id),
      );
      await queue.workflow(finalTranscript, { concurrency: conc("final", 4) }, (p) =>
        wf.finalTranscript(p),
      );
      await queue.workflow(summarizeConversation, { concurrency: conc("summarize", 5) }, (p) =>
        wf.summarize(p),
      );
      // The participant walked away: finish what nobody added to for five minutes.
      await queue.work(finishIdleConversations, { concurrency: 1 }, async () => {
        for (const conversationId of await idleConversations(d.db, d.now()))
          await queue.enqueue(
            finishConversation,
            { conversationId },
            { singletonKey: conversationId },
          );
      });
      await queue.schedule(finishIdleConversations, "*/2 * * * *", {});
      // A locked conversation summarises once its workspace upgrades; a summary that ran
      // out of retries gets another chance.
      await queue.work(catchUpSummaries, { concurrency: 1 }, async () => {
        for (const conversationId of await unsummarizedConversations(d.db, d.now()))
          await queue.enqueue(
            summarizeConversation,
            { conversationId },
            { singletonKey: conversationId },
          );
      });
      await queue.schedule(catchUpSummaries, "*/5 * * * *", {});
      await queue.work(releaseStrandedChunkRuns, { concurrency: 1 }, () =>
        releaseStrandedChunks(d, queue),
      );
      await queue.schedule(releaseStrandedChunkRuns, "*/5 * * * *", {});
    },
  };
}
