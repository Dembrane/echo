import { defineJob, type JobDefinition } from "@dembrane/queue";
import { z } from "zod";

/** Reads a source's frames from the app and writes each as an input. Safe to run twice. */
export const syncSource = defineJob("connectors.sync", z.object({ sourceId: z.string() }), {
  policy: "singleton",
  retryLimit: 2,
  retryDelaySeconds: 60,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
});

/** Hourly: re-reads sources not synced for six hours, so a board that changed catches up. */
export const syncDueSources = defineJob("connectors.sync-due", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 300,
});

/** The jobs the API enqueues. */
export const connectorApiJobs: readonly JobDefinition[] = [syncSource];
