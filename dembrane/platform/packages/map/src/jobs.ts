import { analysisRuntime, clientOf, type RuntimeConfig } from "@dembrane/analysis";
import type { Db } from "@dembrane/db";
import type { Completer, Embedder } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { JobDefinition, Queue } from "@dembrane/queue";
import { factCheckWorkflow, mapFactCheck } from "./factcheck";
import { groupWorkflow, mapGroup } from "./groups";
import { MapStore } from "./store";

/** Jobs the API enqueues, so its queue client knows them before the first send. */
export const mapJobs: readonly JobDefinition[] = [mapFactCheck, mapGroup];

export interface MapWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly embedder: Embedder;
  readonly config: RuntimeConfig;
  /** Wakes the screens outside the Map page that show a project's groups. */
  readonly onGroupChanged?: (projectId: string) => Promise<void>;
}

/** The worker's registration: the fact-check and group workflows. Generation is the analysis run workflow. */
export function mapWorker(deps: MapWorkerDeps) {
  return {
    jobs: [mapFactCheck, mapGroup],
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
      // A group is one short title call; hosts make them by the dozen.
      await queue.workflow(mapGroup, { concurrency: 8 }, async (job) => {
        const outcome = await groupWorkflow(
          { store, rt, completer: deps.completer, onGroupChanged: deps.onGroupChanged },
          job,
        );
        deps.logger.info(
          { group_id: job.groupId, attempt: job.attempt, outcome },
          "map group finished",
        );
      });
    },
  };
}
