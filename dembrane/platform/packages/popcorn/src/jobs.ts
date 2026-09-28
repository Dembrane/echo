import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { z } from "zod";
import type { TickRequest } from "./service";
import type { Sql } from "./storage";

/**
 * One popcorn tick. The API enqueues it inside the transaction that books its backup
 * scheduled_task row, and both carry the same request id: whichever delivery runs first
 * does the read, the other finds the finished run and stops. The worker runs it as a
 * durable workflow (tick.ts).
 */
export const popcornTick = defineJob(
  "popcorn.tick",
  z.object({
    loopId: z.string(),
    tickKind: z.string(),
    requestId: z.string().nullable(),
  }),
  { retryLimit: 0, expireInSeconds: 4 * 60 * 60, policy: "singleton" },
);

/** Jobs the API enqueues for this namespace. */
export const popcornApiJobs: readonly JobDefinition[] = [popcornTick];

/** The API's dispatcher: a tick job that exists only if the booking transaction commits. */
export function queueDispatch(queue: Pick<Queue, "enqueue">) {
  return async (tx: Sql, r: TickRequest): Promise<void> => {
    await queue.enqueue(
      popcornTick,
      { loopId: r.loopId, tickKind: r.tickKind, requestId: r.requestId },
      // DBOS refuses deduplication inside a caller-owned transaction; the tick itself
      // makes a second delivery of one request id a no-op.
      { tx },
    );
  };
}
