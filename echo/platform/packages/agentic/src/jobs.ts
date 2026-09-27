import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Models } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { JobDefinition, Queue } from "@echo/queue";

export interface AgenticWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly models: Models;
  readonly config: Pick<Config, "agentic" | "http">;
}

/** Jobs the API enqueues for this namespace. */
export const agenticApiJobs: readonly JobDefinition[] = [];

/** The worker's registration: agent turns as durable workflows. */
export function agenticWorker(_deps: AgenticWorkerDeps): {
  jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
} {
  return {
    jobs: agenticApiJobs,
    async register(_queue) {},
  };
}
