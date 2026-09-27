import {
  currentWorkflowId,
  defineJob,
  durableSleep,
  type JobDefinition,
  type Queue,
  step,
} from "@echo/queue";
import { z } from "zod";
import { BUSY_RETRY_SECONDS, execute, type WorkerOutcome } from "./executor";
import { sha256Hex } from "./hashing";
import { dispatchEvent, type StepRunner, sweep } from "./outbox";
import {
  type AnalysisRuntime,
  analysisOutbox,
  analysisRun,
  analysisRuntime,
  type RuntimeDeps,
} from "./runtime";

/**
 * The analysis jobs on DBOS.
 *
 * analysis.run is a workflow of two kinds of step: `execute-<n>` runs the recipe under the
 * run's lease and publishes (60-minute timeout, the Python tick limit), and a durable
 * sleep between attempts when the recipe is at its running limit. A worker that dies
 * mid-step is replaced by one that resumes the workflow at that step with the same lease,
 * and the recipe's own completed steps (analysis_step rows) are reused instead of
 * recomputed, so no model call is paid twice. analysis.outbox claims one event and runs
 * each consumer as its own step. The minute sweep stays for what no commit enqueued:
 * expired leases, waiting runs, stranded queued runs and events due for a retry.
 */

export const STEP_TIMEOUT_MS = 60 * 60 * 1000;
/** Deferrals before a busy run is left to the sweep: an hour of asking every 30 seconds. */
export const MAX_DEFERRALS = 120;

/** Every minute on one worker: the sweep of what no commit enqueued. */
export const analysisSweep = defineJob("analysis.sweep", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** A lease that is the same on every replay of one workflow, and new for a new workflow. */
export const leaseFor = (workflowId: string) =>
  sha256Hex(`analysis.run:${workflowId}`).slice(0, 32);

const dbosStep: StepRunner = (name, fn) => step(name, fn, { timeoutMS: 5 * 60 * 1000 });

export async function runWorkflow(rt: AnalysisRuntime, runId: string): Promise<WorkerOutcome> {
  const lease = leaseFor(currentWorkflowId() ?? runId);
  let outcome: WorkerOutcome = "skipped";
  for (let attempt = 1; attempt <= MAX_DEFERRALS; attempt++) {
    outcome = await step(`execute-${attempt}`, () => execute(rt.executor, runId, lease), {
      timeoutMS: STEP_TIMEOUT_MS,
    });
    if (outcome !== "deferred") break;
    await durableSleep(BUSY_RETRY_SECONDS * 1000);
  }
  return outcome;
}

export async function outboxWorkflow(rt: AnalysisRuntime, eventId: string): Promise<string> {
  const claim = sha256Hex(`analysis.outbox:${currentWorkflowId() ?? eventId}`).slice(0, 32);
  const [event] = await step("claim", () =>
    rt.store.claimOutbox({ claim, limit: 1, claimSeconds: 120, eventId }),
  );
  if (!event) return "nothing";
  return dispatchEvent(rt.store, rt.outbox, event, claim, dbosStep);
}

export interface AnalysisWorker {
  readonly jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
}

/** The worker's registration: the run and outbox workflows and the minute sweep. */
export function analysisWorker(deps: Omit<RuntimeDeps, "jobs">): AnalysisWorker {
  return {
    jobs: [analysisRun, analysisOutbox, analysisSweep],
    async register(queue) {
      const rt = analysisRuntime({ ...deps, jobs: queue });
      // Model calls dominate a run; a few at once per instance keep memory and quota in check.
      await queue.workflow(analysisRun, { concurrency: 4 }, async (p) => {
        const outcome = await runWorkflow(rt, p.runId);
        deps.logger.info({ run_id: p.runId, outcome }, "analysis run finished");
      });
      await queue.workflow(analysisOutbox, { concurrency: 8 }, async (p) => {
        await outboxWorkflow(rt, p.eventId);
      });
      await queue.work(analysisSweep, { concurrency: 1 }, async () => {
        const report = await sweep(rt.store, rt.outbox, crypto.randomUUID().replaceAll("-", ""));
        if (
          report.events.claimed ||
          report.expiredRuns ||
          report.wokenRuns ||
          report.redispatchedRuns
        )
          deps.logger.info({ signal: "analysis.sweep", ...report }, "analysis sweep");
      });
      await queue.schedule(analysisSweep, "* * * * *", {});
    },
  };
}
