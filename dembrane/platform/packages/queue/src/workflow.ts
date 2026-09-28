import { DBOS, type StepConfig } from "@dbos-inc/dbos-sdk";

/**
 * A durable multi-step flow: each step's result is checkpointed in Postgres, and after a
 * crash the flow resumes at the first unfinished step on any worker. Steps must be
 * idempotent at their side effects (a step can run twice if a crash lands mid-step).
 * Changing the order or number of steps in a workflow requires bumping WORKFLOW_VERSION.
 */
export function workflow<Args extends unknown[], R>(
  name: string,
  fn: (...args: Args) => Promise<R>,
) {
  return DBOS.registerWorkflow(fn, { name });
}

export function step<R>(
  name: string,
  fn: () => Promise<R>,
  retry: Omit<StepConfig, "name"> = {},
): Promise<R> {
  return DBOS.runStep(fn, { name, ...retry });
}

/** Starts a registered workflow once per id: a second call with the same id returns the first run. */
export function startWorkflow<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  id: string,
  queueName?: string,
) {
  return DBOS.startWorkflow(fn, { workflowID: id, ...(queueName && { queueName }) });
}

/**
 * A durable pause inside a workflow: the wake-up time is checkpointed, so a worker that
 * dies while waiting is replaced by one that sleeps only the remainder.
 */
export function durableSleep(ms: number): Promise<void> {
  return DBOS.sleep(ms);
}

/** The id of the workflow the caller runs in, or null outside one. */
export function currentWorkflowId(): string | null {
  return DBOS.workflowID ?? null;
}
