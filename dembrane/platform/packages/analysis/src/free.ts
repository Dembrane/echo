import { allowanceForProject, giveBack, withAllowanceLock } from "@dembrane/allowance";
import { type Db, schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

const { analysis_run } = schema;
const UNSTAMPED = { free_period_start: null, free_account_id: null };
const BATCH = 100;

/** Gives back the popcorn analysis of each failed run without output, once (popcorn's refund rules). */
export async function refundFailedRuns(
  db: Db,
  now: Date,
  projectId: string | null,
  logger?: Logger,
): Promise<number> {
  // `stamp` pins a clear to the charge that was read.
  const owed = (id?: string, stamp?: string) =>
    and(
      id ? eq(analysis_run.id, id) : undefined,
      stamp ? eq(analysis_run.free_period_start, stamp) : undefined,
      projectId ? eq(analysis_run.project_id, projectId) : undefined,
      eq(analysis_run.status, "failed"),
      isNotNull(analysis_run.free_period_start),
      isNull(analysis_run.output_manifest),
    );
  const rows = await db
    .select({
      id: analysis_run.id,
      stamp: analysis_run.free_period_start,
      projectId: analysis_run.project_id,
      stampMs: sql<string>`(extract(epoch from ${analysis_run.free_period_start}) * 1000)::bigint`,
      accountId: analysis_run.free_account_id,
    })
    .from(analysis_run)
    .where(owed())
    .limit(BATCH);
  let refunded = 0;
  for (const r of rows) {
    try {
      const a = await allowanceForProject(db, r.projectId, now);
      const charged =
        a && Number(r.stampMs) === a.periodStart.getTime() && r.accountId === a.accountId;
      if (!a || !charged) {
        await db
          .update(analysis_run)
          .set(UNSTAMPED)
          .where(owed(r.id, r.stamp ?? undefined));
        continue;
      }
      const given = await withAllowanceLock(db, a, async (tx) => {
        const cleared = await tx
          .update(analysis_run)
          .set(UNSTAMPED)
          .where(owed(r.id, r.stamp ?? undefined))
          .returning({ id: analysis_run.id });
        if (cleared.length === 0) return false;
        await giveBack(tx, a, "popcorn_analyses", 1);
        return true;
      });
      if (given) refunded++;
    } catch (err) {
      logger?.error({ err, run_id: r.id }, "failed analysis run not given back");
    }
  }
  return refunded;
}
