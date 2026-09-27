import { analysisRuntime, clientOf, type RuntimeConfig } from "@echo/analysis";
import type { Db } from "@echo/db";
import type { Completer, Embedder } from "@echo/llm";
import type { Logger } from "@echo/observability";
import type { JobDefinition, Queue } from "@echo/queue";
import { factCheckWorkflow, mapFactCheck } from "./factcheck";
import { MapStore } from "./store";

/** Jobs the API enqueues, so its queue client knows them before the first send. */
export const mapJobs: readonly JobDefinition[] = [mapFactCheck];

export interface MapWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly embedder: Embedder;
  readonly config: RuntimeConfig;
}

/** The worker's registration: the fact-check workflow. Generation is the analysis run workflow. */
export function mapWorker(deps: MapWorkerDeps) {
  return {
    jobs: [mapFactCheck],
    async register(queue: Queue) {
      const rt = analysisRuntime({ ...deps, jobs: queue });
      const store = new MapStore(clientOf(deps.db));
      // Each check waits on a search-grounded model call; several run at once per instance.
      await queue.workflow(mapFactCheck, { concurrency: 8 }, async (job) => {
        const outcome = await factCheckWorkflow({ store, rt, completer: deps.completer }, job);
        deps.logger.info(
          { fact_check_id: job.factCheckId, attempt: job.attempt, outcome },
          "map fact-check finished",
        );
      });
    },
  };
}
