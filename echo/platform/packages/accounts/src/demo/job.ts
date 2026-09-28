import { defineJob } from "@echo/queue";
import { z } from "zod";

// The demo build's job, apart from its code: the API enqueues it and must not load the
// build (and the account services it uses) to do so.

export const demoBuild = defineJob(
  "accounts.demo-build",
  z.object({ demoId: z.string(), attempt: z.number().int() }),
  // The whole run, model calls and the popcorn read included, within half an hour.
  { retryLimit: 0, expireInSeconds: 30 * 60 },
);

/** One run per attempt: a retry is a new workflow that skips the steps already done. */
export const demoWorkflowId = (demoId: string, attempt: number) =>
  `accounts.demo:${demoId}:${attempt}`;
