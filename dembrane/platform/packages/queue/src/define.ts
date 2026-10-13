import type { z } from "zod";
import type { EnqueueOptions } from "./queue";

export const DEFAULT_LOST_WORKER_LIMIT = 3;

/**
 * A job type: its queue name, the payload schema checked on enqueue and on receipt, and
 * the retry behaviour. Namespaces define their jobs next to their handlers; the worker
 * registers the handlers it runs.
 */
export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly schema: S;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** How long one attempt may run before the attempt is treated as failed and retried. */
  readonly expireInSeconds: number;
  /** `singleton` keeps at most one queued or active job per singleton key. */
  readonly policy: "standard" | "singleton" | "stately";
  /**
   * How often a run may be on a worker that stops before recovery sets it aside instead of
   * resuming it once more. A run that cannot finish then waits for a person, and the jobs
   * that shared its workers keep running. Raise it for jobs that must not wait.
   */
  readonly lostWorkerLimit: number;
}

export function defineJob<S extends z.ZodType>(
  name: string,
  schema: S,
  opts: Partial<Omit<JobDefinition<S>, "name" | "schema">> = {},
): JobDefinition<S> {
  if (!/^[a-z][a-z0-9_.-]*$/.test(name))
    throw new Error(`job name "${name}" must be lowercase, dots and dashes`);
  return {
    name,
    schema,
    retryLimit: opts.retryLimit ?? 5,
    retryDelaySeconds: opts.retryDelaySeconds ?? 10,
    retryBackoff: opts.retryBackoff ?? true,
    expireInSeconds: opts.expireInSeconds ?? 15 * 60,
    policy: opts.policy ?? "standard",
    lostWorkerLimit: opts.lostWorkerLimit ?? DEFAULT_LOST_WORKER_LIMIT,
  };
}

export type Payload<J> = J extends JobDefinition<infer S> ? z.input<S> : never;
export type Parsed<J> = J extends JobDefinition<infer S> ? z.output<S> : never;

/** What services need from the queue; the real Queue satisfies it and tests pass a recorder. */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}
