import {
  type AnalysisRuntime,
  advanceMapView,
  claimOf,
  isV2Manifest,
  type Json,
  MapViewReads,
  type ObjectRevision,
  recordAssessment,
  snapshotRevision,
} from "@echo/analysis";
import type { Completer } from "@echo/llm";
import { defineJob, step } from "@echo/queue";
import { z } from "zod";
import { FACTCHECK_PROMPT_VERSION, type FactCheckOutcome, factcheckClaim } from "./model";
import type { MapStore } from "./store";

/**
 * Fact-checks as a DBOS workflow, one per (check, attempt): load the claim the job names,
 * investigate and classify it (the model step, three minutes a call, six in all), write
 * the verdict only while the attempt is current, then record a snapshot revision's verdict
 * as an assessment revision and advance the map view. The Redis attempt lock of the
 * Python worker is the workflow's dedup key: a second delivery of the same attempt joins
 * the first instead of paying for another search. A check that dies is written as an
 * error the analyst can retry, never left processing.
 */

export const mapFactCheck = defineJob(
  "map.fact_check",
  z.object({
    factCheckId: z.string(),
    attempt: z.number().int(),
    resultId: z.string(),
    nodeId: z.string(),
  }),
  { retryLimit: 0, expireInSeconds: 11 * 60 },
);

export interface FactCheckWorkerDeps {
  readonly store: MapStore;
  readonly rt: AnalysisRuntime;
  readonly completer: Completer;
}

interface CheckedClaim {
  readonly statement: string;
  readonly quotes: string[];
  readonly claimKey: string;
  /** The exact revision, when the check was started from a snapshot. */
  readonly revisionId: string | null;
}

/** The claim a job names: a v1 node, or a revision a map snapshot displays. */
async function claimToCheck(
  d: FactCheckWorkerDeps,
  projectId: string,
  resultId: string,
  nodeId: string,
): Promise<CheckedClaim | null> {
  const result = await d.store.getResult(resultId);
  if (result && !isV2Manifest(result.manifest)) {
    const argument = ((result.manifest as Json | null)?.arguments as Json[] | undefined)?.find(
      (a) => a.id === nodeId,
    );
    if (result.project_id !== projectId || !argument?.claim_key) return null;
    const quotes = ((argument.evidence as Json[] | undefined) ?? []).flatMap((i) =>
      ((i.quotes as unknown[] | undefined) ?? []).map(String),
    );
    return {
      statement: String(argument.statement),
      quotes,
      claimKey: String(argument.claim_key),
      revisionId: null,
    };
  }
  if (result && result.project_id !== projectId) return null;
  const snapshotId = result ? String((result.manifest as Json).snapshotId) : resultId;
  const snapshot = await d.rt.store.getSnapshot(snapshotId);
  if (!snapshot || snapshot.projectId !== projectId) return null;
  const revision = await snapshotRevision(snapshot, nodeId, d.rt.store);
  const claim = revision ? claimOf(revision) : null;
  if (!revision || !claim) return null;
  return { statement: claim[0], quotes: claim[1], claimKey: claim[2], revisionId: revision.id };
}

export type FactCheckResult = "done" | "error" | "stale";

/** Runs one attempt as workflow steps; returns done, error or stale. */
export async function runFactCheck(
  d: FactCheckWorkerDeps,
  job: z.output<typeof mapFactCheck.schema>,
  run: <T>(name: string, fn: () => Promise<T>, timeoutMs: number) => Promise<T> = (_n, fn) => fn(),
): Promise<FactCheckResult> {
  const prepared = await run(
    "load",
    async () => {
      const row = await d.store.getFactCheck(job.factCheckId);
      if (row?.status !== "processing" || Number(row.attempt) !== job.attempt)
        return { stale: true as const };
      const projectId = String(row.project_id);
      const claim = await claimToCheck(d, projectId, job.resultId, job.nodeId);
      if (!claim || claim.claimKey !== row.claim_key) {
        const written = await d.store.failFactCheck(
          job.factCheckId,
          job.attempt,
          "The claim is no longer part of this map.",
        );
        return { finished: (written ? "error" : "stale") as FactCheckResult };
      }
      const [name, context] = await d.store.projectContext(projectId);
      return { projectId, claim, name, context, claimKeyRow: String(row.claim_key) };
    },
    60_000,
  );
  if ("stale" in prepared) return "stale";
  if ("finished" in prepared) return prepared.finished;
  const { projectId, claim } = prepared;
  const event = { type: "fact_check", claim_key: prepared.claimKeyRow };

  const outcome = await run(
    "investigate",
    async (): Promise<FactCheckOutcome | { failed: true }> => {
      try {
        return await factcheckClaim(d.completer, {
          statement: claim.statement,
          evidence: claim.quotes,
          projectName: prepared.name,
          projectContext: prepared.context,
        });
      } catch {
        return { failed: true };
      }
    },
    7 * 60_000,
  );
  if ("failed" in outcome) {
    const written = await run(
      "fail",
      () =>
        d.store.failFactCheck(
          job.factCheckId,
          job.attempt,
          "The fact-check could not finish. Try again.",
        ),
      60_000,
    );
    if (written) await d.rt.publishMap(projectId, event);
    return written ? "error" : "stale";
  }

  const written = await run(
    "complete",
    () =>
      d.store.completeFactCheck(job.factCheckId, job.attempt, {
        verdict: outcome.verdict,
        justification: outcome.justification,
        sources: outcome.sources,
        model: d.completer.modelIdentity("multi_modal_fast"),
        promptVersion: FACTCHECK_PROMPT_VERSION,
      }),
    60_000,
  );
  if (!written) return "stale";
  if (claim.revisionId) {
    // The verdict is saved already; recording it as a revision and advancing the view is
    // retried by nothing, so a failure is logged and the check still counts as done.
    await run(
      "record",
      async () => {
        try {
          const completed = await d.store.getFactCheck(job.factCheckId);
          if (completed?.status !== "done") return null;
          const recorded = await recordAssessment(
            d.rt.executor,
            projectId,
            claim.revisionId as string,
            completed as Json,
          );
          if (recorded.eventId)
            await advanceMapView(projectId, d.rt.store, new MapViewReads(d.rt.store), {
              sourceEventId: recorded.eventId,
              publish: d.rt.publishMap,
            });
          return recorded.runId;
        } catch (err) {
          d.rt.executor.logger?.warn(
            { revision_id: claim.revisionId, error: (err as Error)?.constructor?.name },
            "map fact-check not recorded as an assessment",
          );
          return null;
        }
      },
      5 * 60_000,
    );
  }
  await d.rt.publishMap(projectId, event);
  return "done";
}

/** The DBOS form: every phase a checkpointed step with its time limit. */
export async function factCheckWorkflow(
  d: FactCheckWorkerDeps,
  job: z.output<typeof mapFactCheck.schema>,
) {
  try {
    return await runFactCheck(d, job, (name, fn, timeoutMs) =>
      step(name, fn, { timeoutMS: timeoutMs }),
    );
  } catch (err) {
    // An attempt that dies (a step timeout, a lost worker's replay giving up) leaves an
    // error for this attempt rather than a check stuck processing.
    await step("interrupted", () =>
      d.store.failFactCheck(
        job.factCheckId,
        job.attempt,
        "The fact-check was interrupted. Try again.",
      ),
    );
    throw err;
  }
}

export type { ObjectRevision };
