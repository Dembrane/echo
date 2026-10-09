import { type Completer, isRetryable } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import {
  generateReport,
  notifyReportSubscribers,
  REPORT_PROGRESS_CHANNEL,
} from "@dembrane/projects";
import { defineJob, type JobDefinition, type Parsed, type Queue, step } from "@dembrane/queue";
import { z } from "zod";
import {
  buildReportPrompt,
  type ConversationRow,
  conversationsToSummarise,
  extractArticle,
  modelFailure,
  ReportGenerationError,
} from "./generation";
import type { ReportsStorage } from "./storage";
import type { Summarizer } from "./summarize";

/** Five minutes per model call, as REPORT_GENERATION_TIMEOUT was. */
const MODEL_TIMEOUT_MS = 5 * 60_000;
/** Three tries of the call for rate limits and outages, as the backoff decorator made. */
const MODEL_TRIES = 3;
/** A claim older than this is presumed crashed and handed out again (STALE_CLAIM_SECONDS). */
const STALE_CLAIM_MS = 15 * 60_000;

export interface Notify {
  emit(e: {
    audienceUserId: string;
    eventCode: string;
    title: string;
    message?: string | null;
    action?: "NAVIGATE_REPORT";
    refProjectId?: string | null;
    refReportId?: string | null;
    refWorkspaceId?: string | null;
  }): Promise<unknown>;
}

export interface GenerateDeps {
  readonly store: ReportsStorage;
  readonly completer: Completer;
  readonly summarizer: Summarizer;
  readonly logger: Logger;
  readonly now: () => Date;
  /** The context budget in tokens (80% of the smallest multi_modal_pro context). */
  readonly maxContextTokens: number;
  readonly notifier: Notify;
  /** Sends report.generated to the project's webhooks. */
  readonly reportGenerated: (projectId: string, reportId: number) => Promise<unknown>;
  /** Tests stretch a step to crash a worker inside it. */
  readonly pause?: (step: string) => Promise<void>;
}

type Payload = Parsed<typeof generateReport>;

/** Progress for the report page's stream, delivered on commit of nothing: a nudge, best effort. */
async function progress(
  d: GenerateDeps,
  reportId: number,
  type: string,
  message: string,
  detail: Record<string, unknown> | null = null,
) {
  try {
    await d.store.sql`select pg_notify(${REPORT_PROGRESS_CHANNEL}, ${JSON.stringify({
      report_id: reportId,
      event: { type, message, detail },
    })})`;
  } catch (err) {
    d.logger.warn({ err, reportId }, "report progress publish failed");
  }
}

/** The processing_status row ProcessingStatusContext wrote when a phase ended. */
async function phaseEnded(
  d: GenerateDeps,
  p: Payload,
  phase: "task_create_report" | "task_create_report_continue",
  outcome: "completed" | "failed",
  message: string,
  started: number,
) {
  await d.store.processingStatus({
    project_id: p.projectId,
    event: `${phase}.${outcome}`,
    message,
    duration_ms: Math.max(0, Math.round(Date.now() - started)),
    now: d.now().toISOString(),
  });
}

/**
 * PostHog capture of the server-side report events. No analytics capability exists on the
 * platform yet, so the event is logged with the fields PostHog received; the log line is
 * the count until a capability replaces it.
 */
function analytics(d: GenerateDeps, event: string, props: Record<string, unknown>) {
  d.logger.info({ signal: "analytics", event, ...props }, "analytics event");
}

async function markError(d: GenerateDeps, p: Payload, code: string, message: string) {
  const now = d.now().toISOString();
  try {
    await d.store.updateReport(p.reportId, {
      status: "error",
      error_code: code,
      error_message: message,
      date_updated: now,
    });
  } catch (err) {
    d.logger.error({ err, reportId: p.reportId }, "failed to update report status to error");
  }
  await progress(d, p.reportId, "failed", message);
}

async function creator(d: GenerateDeps, p: Payload) {
  const report = await d.store.report(String(p.reportId));
  const directusId = report?.user_created ? String(report.user_created) : null;
  const user = directusId ? await d.store.appUserByDirectusId(directusId) : null;
  const project = await d.store.project(p.projectId);
  return { user, project };
}

type Phase1 = { go: false } | { go: true; missing: string[] };
type Phase2 =
  | { kind: "skip" }
  | { kind: "content"; content: string }
  | { kind: "failed"; message: string };

/**
 * One report, from draft to archived content. Replaces Python's two dramatiq phases, the
 * Redis key that carried the parameters between them and the group callback that waited
 * for the summaries: each stage is a checkpointed step, so a crash resumes at the stage it
 * was in and summaries already written are not asked for again.
 */
export function generateReportWorkflow(d: GenerateDeps) {
  return async (p: Payload): Promise<void> => {
    const t0 = await step("started-at", async () => Date.now());
    const phase1 = await step<Phase1>(
      "guard",
      async () => {
        const report = await d.store.report(String(p.reportId));
        if (!report || (report.status !== "draft" && report.status !== "scheduled")) {
          await phaseEnded(d, p, "task_create_report", "completed", `for report ${p.reportId}`, t0);
          return { go: false };
        }
        if (report.status === "scheduled")
          await d.store.updateReport(p.reportId, {
            status: "draft",
            date_updated: d.now().toISOString(),
          });
        analytics(d, "server_report_generation_started", {
          project_id: p.projectId,
          report_id: p.reportId,
          language: p.language,
        });
        try {
          const rows = (await d.store.conversationsForReport(
            p.projectId,
          )) as unknown as ConversationRow[];
          const { withChunks, missing } = conversationsToSummarise(rows);
          if (missing.length)
            await progress(
              d,
              p.reportId,
              "summarizing",
              `Summarizing ${missing.length} conversations...`,
              {
                total: missing.length,
              },
            );
          else
            await progress(d, p.reportId, "summarizing", "All conversations already summarized.", {
              total: withChunks,
            });
          await phaseEnded(d, p, "task_create_report", "completed", `for report ${p.reportId}`, t0);
          return { go: true, missing };
        } catch (err) {
          if (err instanceof ReportGenerationError) {
            await markError(d, p, "GENERATION_FAILED", err.message);
            await phaseEnded(
              d,
              p,
              "task_create_report",
              "completed",
              `for report ${p.reportId}`,
              t0,
            );
            return { go: false };
          }
          await markError(d, p, "UNEXPECTED_ERROR", String((err as Error)?.message ?? err));
          await phaseEnded(
            d,
            p,
            "task_create_report",
            "failed",
            String((err as Error)?.message ?? err),
            t0,
          );
          throw err;
        }
      },
      { timeoutMS: 2 * 60_000 },
    );
    if (!phase1.go) return;

    // A summary that keeps failing no longer stalls the report: the report is made from
    // the conversations that have one, where Python's group callback never fired.
    for (const conversationId of phase1.missing) {
      try {
        await step(
          `summarize:${conversationId}`,
          async () => {
            await d.pause?.(`summarize:${conversationId}`);
            return d.summarizer.summarize(conversationId);
          },
          {
            retriesAllowed: true,
            maxAttempts: 3,
            intervalSeconds: 10,
            backoffRate: 2,
            timeoutMS: 10 * 60_000,
          },
        );
      } catch (err) {
        d.logger.warn(
          { err, conversationId, reportId: p.reportId },
          "summary failed; report goes on",
        );
      }
    }

    const t1 = await step("phase-two-at", async () => Date.now());
    const phase2 = await step<Phase2>(
      "generate",
      async () => {
        await d.pause?.("generate");
        const report = await d.store.report(String(p.reportId));
        if (report?.status !== "draft") return { kind: "skip" };
        try {
          const rows = (await d.store.conversationsForReport(
            p.projectId,
          )) as unknown as ConversationRow[];
          let announced = false;
          const built = await buildReportPrompt(
            rows,
            async (id) => {
              if (!announced) {
                announced = true;
                await progress(d, p.reportId, "fetching_transcripts", "Fetching transcripts...");
              }
              try {
                return await d.store.transcript(id);
              } catch {
                return null;
              }
            },
            {
              language: p.language,
              userInstructions: p.userInstructions,
              maxTokens: d.maxContextTokens,
            },
          );
          if (!announced && built.prompt !== null)
            await progress(d, p.reportId, "fetching_transcripts", "Fetching transcripts...");
          if (built.prompt === null) return { kind: "content", content: built.fallback ?? "" };
          await progress(d, p.reportId, "generating", "Generating report...");
          const text = await callModel(d, built.prompt);
          if (!text)
            return { kind: "content", content: "Report generation returned empty content" };
          return { kind: "content", content: extractArticle(text) };
        } catch (err) {
          if (err instanceof ReportGenerationError) return { kind: "failed", message: err.message };
          const message = String((err as Error)?.message ?? err);
          analytics(d, "server_report_generation_failed", {
            project_id: p.projectId,
            report_id: p.reportId,
            error_code: "UNEXPECTED_ERROR",
          });
          await markError(d, p, "UNEXPECTED_ERROR", message);
          await phaseEnded(d, p, "task_create_report_continue", "failed", message, t1);
          throw err;
        }
      },
      { timeoutMS: 20 * 60_000 },
    );
    if (phase2.kind === "skip") {
      await step("skipped", () =>
        phaseEnded(
          d,
          p,
          "task_create_report_continue",
          "completed",
          `for report ${p.reportId}`,
          t1,
        ),
      );
      return;
    }

    if (phase2.kind === "failed") {
      await step("failed", async () => {
        await markError(d, p, "GENERATION_FAILED", phase2.message);
        const { user, project } = await creator(d, p);
        if (user)
          await d.notifier.emit({
            audienceUserId: user.id,
            eventCode: "REPORT_FAILED",
            title: "Report generation ran into a problem",
            message: "Open the report to retry or check details.",
            action: "NAVIGATE_REPORT",
            refProjectId: p.projectId,
            refReportId: String(p.reportId),
            refWorkspaceId: (project?.workspace_id as string | null) ?? null,
          });
        analytics(d, "server_report_generation_failed", {
          project_id: p.projectId,
          report_id: p.reportId,
          error_code: "GENERATION_FAILED",
        });
        await phaseEnded(
          d,
          p,
          "task_create_report_continue",
          "completed",
          `for report ${p.reportId}`,
          t1,
        );
      });
      return;
    }

    const saved = await step("save", async () => {
      const report = await d.store.report(String(p.reportId));
      // A host may have cancelled or deleted the draft while the model worked.
      if (report?.status !== "draft") return false;
      const now = d.now().toISOString();
      await d.store.updateReport(p.reportId, {
        content: phase2.content,
        status: "archived",
        date_created: now,
        date_updated: now,
      });
      await progress(d, p.reportId, "completed", "Report ready");
      analytics(d, "server_report_generated", {
        project_id: p.projectId,
        report_id: p.reportId,
        language: p.language,
      });
      return true;
    });
    if (saved) {
      await step("notify", async () => {
        const { user, project } = await creator(d, p);
        if (!user) return;
        await d.notifier.emit({
          audienceUserId: user.id,
          eventCode: "REPORT_READY",
          title: "Your report is ready",
          message: `**${(project?.name as string | null) || "your project"}** — open to review.`,
          action: "NAVIGATE_REPORT",
          refProjectId: p.projectId,
          refReportId: String(p.reportId),
          refWorkspaceId: (project?.workspace_id as string | null) ?? null,
        });
      });
      await step("webhook", async () => {
        try {
          await d.reportGenerated(p.projectId, p.reportId);
        } catch (err) {
          d.logger.warn({ err, reportId: p.reportId }, "report.generated webhook not dispatched");
        }
      });
    }
    await step("finished", () =>
      phaseEnded(d, p, "task_create_report_continue", "completed", `for report ${p.reportId}`, t1),
    );
  };
}

async function callModel(d: GenerateDeps, prompt: string): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= MODEL_TRIES; attempt++) {
    try {
      const answer = await d.completer.complete({
        group: "multi_modal_pro",
        user: prompt,
        timeoutMs: MODEL_TIMEOUT_MS,
      });
      return answer.text;
    } catch (err) {
      last = err;
      if (!isRetryable(err) || attempt === MODEL_TRIES) break;
      d.logger.warn(
        { attempt, err: { message: (err as Error).message } },
        "report model call retried",
      );
      await Bun.sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw modelFailure(last);
}

// ── the scheduled report runner ─────────────────────────────────────

/** Every minute: fire the scheduled reports whose time came (generate_report rows). */
export const scheduledReports = defineJob("reports.scheduled", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** Every five minutes: give every still-scheduled report the task row that fires it. */
export const backfillScheduledReports = defineJob("reports.backfill-scheduled", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

export interface Enqueuer {
  enqueue(
    def: typeof generateReport,
    payload: Parsed<typeof generateReport>,
    opts?: { tx?: unknown },
  ): Promise<unknown>;
}

/**
 * Claims due generate_report rows, moves each still-scheduled report to draft and
 * enqueues its generation in the same transaction, so a fired report always has a job.
 */
export async function runScheduledReports(d: {
  store: ReportsStorage;
  jobs: Enqueuer;
  now?: () => Date;
}): Promise<number> {
  const now = (d.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  await d.store.resetStaleClaims(nowIso, new Date(now.getTime() - STALE_CLAIM_MS).toISOString());
  const due = await d.store.claimDueTasks(nowIso, 50);
  for (const row of due) {
    let error: string | null = null;
    try {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const reportId = payload.report_id;
      const projectId = payload.project_id;
      if (!reportId || !projectId)
        throw new Error("generate_report payload missing report_id/project_id");
      await d.store.transaction(async (tx) => {
        const report = await tx.report(String(reportId));
        if (!report || report.deleted_at || report.status !== "scheduled") return;
        await tx.updateReport(Number(reportId), { status: "draft", date_updated: nowIso });
        await d.jobs.enqueue(
          generateReport,
          {
            projectId: String(projectId),
            reportId: Number(reportId),
            language: (payload.language as string | undefined) || "en",
            userInstructions: (payload.user_instructions as string | undefined) || "",
          },
          { tx: tx.sql },
        );
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await d.store.settleTask(row.id, new Date().toISOString(), error);
  }
  return due.length;
}

/** task_check_scheduled_reports: a scheduled report without a live task row gets one. */
export async function backfillScheduled(d: { store: ReportsStorage; now?: () => Date }) {
  const nowIso = (d.now ?? (() => new Date()))().toISOString();
  const sql = d.store.sql;
  const reports = await sql`select id, project_id, language, user_instructions, scheduled_at
    from project_report where status = 'scheduled' and deleted_at is null order by id limit 100`;
  if (!reports.length) return 0;
  const tasks = await d.store.pendingTasks();
  const covered = new Set(
    tasks
      .map((t) => t.payload.report_id)
      .filter((v) => v != null)
      .map(String),
  );
  let n = 0;
  for (const r of reports) {
    if (!r.project_id || !r.scheduled_at || covered.has(String(r.id))) continue;
    await d.store.bookTask(
      {
        report_id: Number(r.id),
        project_id: r.project_id,
        language: r.language || "en",
        user_instructions: r.user_instructions || "",
      },
      r.scheduled_at,
      nowIso,
    );
    n++;
  }
  return n;
}

export const reportWorkerJobs: readonly JobDefinition[] = [
  generateReport,
  notifyReportSubscribers,
  scheduledReports,
  backfillScheduledReports,
];

/** Registers the generation workflow and the two schedules on a worker's queue. */
export async function registerReportJobs(
  queue: Queue,
  d: GenerateDeps & { jobs: Enqueuer },
): Promise<void> {
  await queue.workflow(generateReport, { concurrency: 4 }, generateReportWorkflow(d));
  await queue.work(scheduledReports, { concurrency: 1 }, async () => {
    const n = await runScheduledReports(d);
    if (n) d.logger.info({ tasks: n }, "scheduled reports processed");
  });
  await queue.work(backfillScheduledReports, { concurrency: 1 }, async () => {
    const n = await backfillScheduled(d);
    if (n) d.logger.info({ backfilled: n }, "scheduled report tasks backfilled");
  });
  await queue.schedule(scheduledReports, "* * * * *", {});
  await queue.schedule(backfillScheduledReports, "*/5 * * * *", {});
}
