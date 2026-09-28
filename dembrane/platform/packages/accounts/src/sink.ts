import type { JobDefinition, Payload, Queue } from "@dembrane/queue";
import type postgres from "postgres";
import type { Conn } from "./deps";

/**
 * Enqueues a job inside the caller's transaction, so a job exists only if the write that
 * caused it committed. `workflowId` makes a second enqueue of the same run a no-op: the
 * reminder of one task at one due time is sent once however often the tick sees it.
 */
export interface AccountsJobs {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: { tx?: Conn; workflowId?: string; startAfter?: Date },
  ): Promise<void>;
}

/** The postgres.js handle under a Drizzle pool or transaction. */
function rawSql(conn: Conn): postgres.Sql | postgres.TransactionSql {
  return (conn as unknown as { session: { client: postgres.Sql | postgres.TransactionSql } })
    .session.client;
}

export function queueJobs(queue: Pick<Queue, "enqueue">): AccountsJobs {
  return {
    async enqueue(def, payload, opts = {}) {
      await queue.enqueue(def, payload, {
        ...(opts.tx && { tx: rawSql(opts.tx) }),
        ...(opts.workflowId && { workflowId: opts.workflowId }),
        ...(opts.startAfter && { startAfter: opts.startAfter }),
      });
    },
  };
}

/** Records jobs instead of queueing them; for tests. Honours workflowId like the queue. */
export class MemoryJobs implements AccountsJobs {
  readonly jobs: { name: string; payload: unknown; workflowId?: string }[] = [];
  async enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts: { workflowId?: string } = {},
  ) {
    if (opts.workflowId && this.jobs.some((j) => j.workflowId === opts.workflowId)) return;
    this.jobs.push({
      name: def.name,
      payload: def.schema.parse(payload),
      ...(opts.workflowId && { workflowId: opts.workflowId }),
    });
  }
  of(name: string) {
    return this.jobs
      .filter((j) => j.name === name)
      .map((j) => j.payload as Record<string, unknown>);
  }
}
