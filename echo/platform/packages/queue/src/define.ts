import type { z } from "zod";

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
  };
}

export type Payload<J> = J extends JobDefinition<infer S> ? z.input<S> : never;
export type Parsed<J> = J extends JobDefinition<infer S> ? z.output<S> : never;
