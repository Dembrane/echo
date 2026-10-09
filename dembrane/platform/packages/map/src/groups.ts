import type { AnalysisRuntime } from "@dembrane/analysis";
import type { Completer } from "@dembrane/llm";
import { defineJob, step } from "@dembrane/queue";
import { z } from "zod";
import { TITLE_PROMPT, titleSelection } from "./model";
import { announceGroup, type GroupAnnounce, snapshotTitleLines } from "./service";
import type { MapStore } from "./store";

/**
 * Groups as a DBOS workflow, one per (group, attempt): a dwell whose circle closed was
 * committed by the API, and from here it no longer depends on the page. Load the pending
 * group, read its members' title lines from the snapshot it was made in, ask the title
 * model, and write the title only while the attempt is current. Every outcome is
 * published on the map channel and to the screens showing the project's groups, so
 * everyone on the page and in the room sees the group land.
 */

export const mapGroup = defineJob(
  "map.group",
  z.object({ groupId: z.string(), attempt: z.number().int() }),
  { retryLimit: 0, expireInSeconds: 5 * 60 },
);

export interface GroupWorkerDeps extends GroupAnnounce {
  readonly store: MapStore;
  readonly rt: AnalysisRuntime;
  readonly completer: Completer;
}

export type GroupResult = "ready" | "failed" | "stale";

/** Runs one attempt as workflow steps; returns ready, failed or stale. */
export async function runGroup(
  d: GroupWorkerDeps,
  job: z.output<typeof mapGroup.schema>,
  run: <T>(name: string, fn: () => Promise<T>, timeoutMs: number) => Promise<T> = (_n, fn) => fn(),
): Promise<GroupResult> {
  const fail = async (projectId: string, message: string): Promise<GroupResult> => {
    const written = await run(
      "fail",
      () => d.store.failGroup(job.groupId, job.attempt, message),
      60_000,
    );
    if (written) await announceGroup(d, projectId, job.groupId);
    return written ? "failed" : "stale";
  };

  const prepared = await run(
    "load",
    async () => {
      const row = await d.store.getGroup(job.groupId);
      if (row?.status !== "pending" || Number(row.attempt) !== job.attempt)
        return { stale: true as const };
      const projectId = String(row.project_id);
      const snapshot = await d.rt.store.getSnapshot(String(row.snapshot_id));
      if (!snapshot || snapshot.projectId !== projectId)
        return { projectId, gone: "The map this group was made on is gone." };
      const ids = ((row.members as { revisionId: string }[]) ?? []).map((m) => m.revisionId);
      let lines: string[];
      try {
        ({ lines } = await snapshotTitleLines(d, snapshot, ids));
      } catch (err) {
        return { projectId, gone: (err as Error).message };
      }
      const [name, context] = await d.store.projectContext(projectId);
      return { projectId, lines, name, context };
    },
    60_000,
  );
  if ("stale" in prepared) return "stale";
  if ("gone" in prepared) return fail(prepared.projectId, String(prepared.gone));
  const { projectId } = prepared;

  const titled = await run(
    "title",
    async (): Promise<{ title: string } | { failed: true }> => {
      try {
        const title = await titleSelection(d.completer, {
          lines: prepared.lines,
          projectName: prepared.name,
          projectContext: prepared.context,
        });
        return title ? { title } : { failed: true };
      } catch {
        return { failed: true };
      }
    },
    2 * 60_000,
  );
  if ("failed" in titled) return fail(projectId, "The title could not be generated. Try again.");

  const written = await run(
    "complete",
    () =>
      d.store.completeGroup(job.groupId, job.attempt, {
        title: titled.title,
        model: d.completer.modelIdentity("multi_modal_fast"),
        promptVersion: TITLE_PROMPT,
      }),
    60_000,
  );
  if (!written) return "stale";
  await announceGroup(d, projectId, job.groupId);
  return "ready";
}

/** The DBOS form: every phase a checkpointed step with its time limit. */
export async function groupWorkflow(d: GroupWorkerDeps, job: z.output<typeof mapGroup.schema>) {
  try {
    return await runGroup(d, job, (name, fn, timeoutMs) =>
      step(name, fn, { timeoutMS: timeoutMs }),
    );
  } catch (err) {
    // An attempt that dies leaves a failed group the host can retry, never one pending.
    const failed = await step("interrupted", () =>
      d.store.failGroup(job.groupId, job.attempt, "The group was interrupted. Try again."),
    );
    // Telling the pages is best effort; the attempt's own error is what the run reports.
    if (failed)
      await step("interrupted-announce", async () => {
        const row = await d.store.getGroup(job.groupId);
        if (row) await announceGroup(d, String(row.project_id), job.groupId);
      }).catch(() => {});
    throw err;
  }
}
