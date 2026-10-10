import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type { JobDefinition, Queue } from "@dembrane/queue";
import { eq } from "drizzle-orm";
import { backfillBestPractices, sampleOwner, seedBestPractices } from "./best-practices";
import { backfillBestPracticesJob, seedBestPracticesJob } from "./jobs";

export interface SamplesWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** Organisations that never get a copy: the synthetic demo and preview samples. */
  readonly excludeOrgIds: readonly string[];
  readonly now?: () => Date;
}

/** One workspace's seed job: skipped for an excluded org or a workspace with no owner. */
export async function runSeedJob(deps: SamplesWorkerDeps, workspaceId: string) {
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

export function samplesWorker(deps: SamplesWorkerDeps) {
  const jobs: JobDefinition[] = [seedBestPracticesJob, backfillBestPracticesJob];
  return {
    jobs,
    async register(queue: Queue) {
      await queue.work(seedBestPracticesJob, { concurrency: 2 }, async (p) => {
        const out = await runSeedJob(deps, p.workspaceId);
        deps.logger.info(
          { signal: "samples.seed", workspace_id: p.workspaceId, status: out?.status ?? "skipped" },
          "best-practices sample seeded",
        );
      });
      await queue.work(backfillBestPracticesJob, { concurrency: 1 }, async () => {
        const report = await backfillBestPractices(
          deps.db,
          { now: deps.now?.() ?? new Date(), excludeOrgIds: deps.excludeOrgIds },
          (err, workspaceId) =>
            deps.logger.error({ err, workspace_id: workspaceId }, "best-practices seed failed"),
        );
        if (report.created || report.updated || report.failed)
          deps.logger.info({ signal: "samples.backfill", ...report }, "best-practices backfill");
      });
      await queue.schedule(backfillBestPracticesJob, "*/10 * * * *", {});
    },
  };
}
