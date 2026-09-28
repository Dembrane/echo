import { defineJob, type EnqueueOptions, type JobDefinition, type Payload } from "@echo/queue";
import { z } from "zod";

/** What services need from the queue; the real Queue satisfies it and tests pass a recorder. */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}

/**
 * Report generation, phase one. The producer is the create-report route; the handler is
 * the language model pipeline, which the reports namespace owns and registers.
 */
export const generateReport = defineJob(
  "reports.generate",
  z.object({
    projectId: z.string(),
    reportId: z.number().int(),
    language: z.string(),
    userInstructions: z.string(),
  }),
  { retryLimit: 3, expireInSeconds: 30 * 60 },
);

/** Jobs the API enqueues, so its queue client can create them before the first send. */
export const projectJobs: readonly JobDefinition[] = [generateReport];
