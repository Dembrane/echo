import type { Db } from "@dembrane/db";
import type { Completer } from "@dembrane/llm";
import { Notifier } from "@dembrane/notifications";
import type { Logger } from "@dembrane/observability";
import type { Queue } from "@dembrane/queue";
import { enqueueConversationEvent, enqueueReportEvent, webhooksStorage } from "@dembrane/webhooks";
import type postgres from "postgres";
import { registerReportJobs, reportWorkerJobs } from "./jobs";
import { reportsStorage } from "./storage";
import { type Summarizer, summarizeConversation } from "./summarize";

export interface ReportsWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly dashboardUrl: string;
  readonly config: { readonly reports: { readonly maxContextTokens: number } };
  /** The conversations namespace's summarizer once it exists; the port below until then. */
  readonly summarizer?: Summarizer;
}

/** Report generation, the scheduled report runner and its reconciler, for the worker. */
export function reportsWorker(deps: ReportsWorkerDeps) {
  return {
    jobs: reportWorkerJobs,
    async register(queue: Queue) {
      const now = () => new Date();
      const store = reportsStorage(deps.db);
      const webhookDeps = {
        store: webhooksStorage(deps.db),
        jobs: { enqueue: queue.enqueue.bind(queue) },
        now,
        enabled: true,
        dashboardUrl: deps.dashboardUrl,
      };
      const summarizer =
        deps.summarizer ??
        summarizeConversation({
          sql: (deps.db as unknown as { $client: postgres.Sql }).$client,
          completer: deps.completer,
          logger: deps.logger,
          now,
          onSummarized: (projectId, conversationId) =>
            enqueueConversationEvent(
              webhookDeps,
              projectId,
              conversationId,
              "conversation.summarized",
            ),
        });
      await registerReportJobs(queue, {
        store,
        completer: deps.completer,
        summarizer,
        logger: deps.logger,
        now,
        maxContextTokens: deps.config.reports.maxContextTokens,
        notifier: new Notifier(deps.db, deps.logger),
        reportGenerated: (projectId, reportId) =>
          enqueueReportEvent(webhookDeps, projectId, reportId, "report.generated"),
        jobs: { enqueue: (def, payload, opts) => queue.enqueue(def, payload, opts as never) },
      });
    },
  };
}
