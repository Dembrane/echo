import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type { JobDefinition, Queue } from "@dembrane/queue";
import { eq } from "drizzle-orm";
import {
  type BackfillReport,
  backfillBestPractices,
  sampleOwner,
  seedBestPractices,
} from "./best-practices";
import { backfillBestPracticesJob, seedBestPracticesJob } from "./jobs";

export interface SamplesWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  /**
   * False where the sample is not released (samples.enabled): the seed and the backfill
   * return at once and write nothing, so no workspace gets a copy and no copy is brought up
   * to date. Copies that exist stay as they are.
   */
  readonly enabled: boolean;
  /** Organisations that never get a copy: the synthetic demo and preview samples. */
  readonly excludeOrgIds: readonly string[];
  readonly now?: () => Date;
}

/**
 * One workspace's seed job: skipped where samples are off, for an excluded org and for a
 * workspace with no owner.
 */
export async function runSeedJob(deps: SamplesWorkerDeps, workspaceId: string) {
  if (!deps.enabled) return null;
  const now = deps.now?.() ?? new Date();
  const [ws] = await deps.db
    .select({ orgId: schema.workspace.org_id })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, workspaceId));
  if (!ws || deps.excludeOrgIds.includes(ws.orgId)) return null;
  const owner = await sampleOwner(deps.db, workspaceId);
  if (!owner) return null;
  return seedBestPractices(deps.db, owner, workspaceId, now);
}

/** The scheduled backfill: null, with nothing read or written, where samples are off. */
export async function runBackfillJob(deps: SamplesWorkerDeps): Promise<BackfillReport | null> {
  if (!deps.enabled) return null;
  return backfillBestPractices(
    deps.db,
    { now: deps.now?.() ?? new Date(), excludeOrgIds: deps.excludeOrgIds },
    (err, workspaceId) =>
      deps.logger.error({ err, workspace_id: workspaceId }, "best-practices seed failed"),
  );
}

/**
 * The handlers and the schedule are registered where samples are off too, so a seed job a
 * workspace creation queued is taken off the queue and the schedule is the same in every
 * environment; the two run functions above decide whether anything is written.
 */
export function samplesWorker(deps: SamplesWorkerDeps) {
  const jobs: JobDefinition[] = [seedBestPracticesJob, backfillBestPracticesJob];
  return {
    jobs,
    async register(queue: Queue) {
      await queue.work(seedBestPracticesJob, { concurrency: 2 }, async (p) => {
        const out = await runSeedJob(deps, p.workspaceId);
        const status = out?.status ?? (deps.enabled ? "skipped" : "off");
        deps.logger.info(
          { signal: "samples.seed", workspace_id: p.workspaceId, status },
          "best-practices sample seeded",
        );
      });
      await queue.work(backfillBestPracticesJob, { concurrency: 1 }, async () => {
        const report = await runBackfillJob(deps);
        if (report && (report.created || report.updated || report.failed))
          deps.logger.info({ signal: "samples.backfill", ...report }, "best-practices backfill");
      });
      await queue.schedule(backfillBestPracticesJob, "*/10 * * * *", {});
    },
  };
}
