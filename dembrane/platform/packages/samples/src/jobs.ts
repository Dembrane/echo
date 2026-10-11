import { defineJob, type JobDefinition } from "@dembrane/queue";
import { z } from "zod";

/**
 * The sample jobs, on their own so the namespaces that create workspaces can enqueue one
 * without loading the fixtures (@dembrane/samples/jobs).
 */

/**
 * Seeds a new workspace's copy of the best-practices sample. Queued by every workspace
 * creation, so signing up or adding a workspace neither waits on nor fails with the seed;
 * the backfill below catches a job that never ran.
 */
export const seedBestPracticesJob = defineJob(
  "samples.seed-best-practices",
  z.object({ workspaceId: z.string().uuid() }),
  { retryLimit: 3, retryDelaySeconds: 30, expireInSeconds: 120 },
);

/** Every ten minutes: copies for workspaces that have none, and copies of an older fixture. */
export const backfillBestPracticesJob = defineJob("samples.backfill-best-practices", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 10 * 60,
});

/** The jobs the API enqueues; its queue client creates exactly these. */
export const samplesApiJobs: readonly JobDefinition[] = [seedBestPracticesJob];
