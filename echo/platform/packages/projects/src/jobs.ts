import type { Logger } from "@echo/observability";
import { defineJob, type EnqueueOptions, type JobDefinition, type Payload } from "@echo/queue";
import { z } from "zod";
import type { ProjectsStorage } from "./storage";

/** What services need from the queue; the real Queue satisfies it and tests pass a recorder. */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}

/**
 * Regenerates a project's library: records a new analysis run. The producer mints the run
 * id, so a retried job inserts nothing twice.
 */
export const createLibrary = defineJob(
  "projects.library.create",
  z.object({ projectId: z.string(), runId: z.string(), language: z.string() }),
  { retryLimit: 3 },
);

/**
 * A custom view on the latest analysis run. The topic modeller behind views is gone, so
 * the job only records that it skipped; the route stays because the dashboard still calls it.
 */
export const createView = defineJob(
  "projects.view.create",
  z.object({
    analysisRunId: z.string(),
    query: z.string(),
    context: z.string(),
    language: z.string(),
  }),
  { retryLimit: 3 },
);

/**
 * Report generation, phase one. The producer is the create-report route; the handler is
 * the language model pipeline, which the reports namespace owns and registers.
 */
export const generateReport = defineJob(
  "reports.generate",
  z.object({
    projectId: z.string(),
    reportId: z.number().int(),
    language: z.string(),
    userInstructions: z.string(),
  }),
  { retryLimit: 3, expireInSeconds: 30 * 60 },
);

/** Jobs the API enqueues, so its queue client can create them before the first send. */
export const projectJobs: readonly JobDefinition[] = [createLibrary, createView, generateReport];

interface JobDeps {
  readonly store: ProjectsStorage;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * The processing_status row the dashboard reads for these tasks: only the finishing event
 * is stored, with its duration, as the Python ProcessingStatusContext did.
 */
async function finished(
  deps: JobDeps,
  started: number,
  row: { event: string; message: string; project_id?: string; project_analysis_run_id?: string },
) {
  await deps.store.insertProcessingStatus({
    ...row,
    duration_ms: Math.round(performance.now() - started),
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
  });
}

export async function runCreateLibrary(deps: JobDeps, p: z.output<typeof createLibrary.schema>) {
  const started = performance.now();
  const event = "task_create_project_library.completed";
  const project = await deps.store.project(p.projectId);
  if (!project) {
    await finished(deps, started, {
      event,
      message: `Project not found: ${p.projectId}`,
      project_id: p.projectId,
    });
    return;
  }
  if (!(await deps.store.analysisRun(p.runId))) {
    const now = (deps.now?.() ?? new Date()).toISOString();
    await deps.store.insertAnalysisRun({
      id: p.runId,
      project_id: p.projectId,
      created_at: now,
      updated_at: now,
    });
  }
  deps.logger.info({ project_id: p.projectId, run_id: p.runId }, "library created");
  await finished(deps, started, {
    event,
    message: `Successfully created library: ${p.runId}`,
    project_id: p.projectId,
  });
}

export async function runCreateView(deps: JobDeps, p: z.output<typeof createView.schema>) {
  const started = performance.now();
  if (!p.analysisRunId || !p.query) return;
  const run = await deps.store.analysisRun(p.analysisRunId);
  if (!run) {
    deps.logger.warn({ run_id: p.analysisRunId }, "analysis run not found, view skipped");
    return;
  }
  await finished(deps, started, {
    event: "task_create_view.completed",
    message: "Topic modeler integration has been removed; skipping view creation.",
    project_analysis_run_id: p.analysisRunId,
    ...(run.project_id && { project_id: run.project_id }),
  });
}
