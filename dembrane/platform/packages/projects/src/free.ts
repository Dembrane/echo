import {
  type AllowanceAccount,
  allowanceForProject,
  freeLimitError,
  freeLimits,
  giveBack,
  take,
  withAllowanceLock,
} from "@dembrane/allowance";
import { type Db, schema } from "@dembrane/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

const { project, project_report } = schema;

// Takes the period's report; null when the project is unlimited or a sample.
export async function takeFreeReport(
  db: Db,
  projectId: string,
  now: Date,
): Promise<AllowanceAccount | null> {
  const a = await allowanceForProject(db, projectId, now);
  if (!a) return null;
  const [p] = await db
    .select({ is_sample: project.is_sample })
    .from(project)
    .where(eq(project.id, projectId));
  if (p?.is_sample === true) return null;
  const limits = await freeLimits(db);
  const t = await take(db, a, "reports", 1, limits.reports_month);
  if (!t.ok) throw freeLimitError("report", { used: t.used, cap: t.limit });
  return a;
}

// Gives back a stamped report that produced nothing, once; true when it gave one back.
export async function refundFreeReport(db: Db, reportId: number, now: Date): Promise<boolean> {
  const id = BigInt(reportId);
  const [r] = await db
    .select({
      projectId: project_report.project_id,
      stampMs: sql<string>`(extract(epoch from ${project_report.free_period_start}) * 1000)::bigint`,
    })
    .from(project_report)
    .where(
      and(
        eq(project_report.id, id),
        isNotNull(project_report.free_period_start),
        sql`coalesce(${project_report.content}, '') = ''`,
      ),
    );
  if (!r) return false;
  const stamped = and(eq(project_report.id, id), isNotNull(project_report.free_period_start));
  const a = r.projectId ? await allowanceForProject(db, r.projectId, now) : null;
  if (!a || Number(r.stampMs) !== a.periodStart.getTime()) {
    await db.update(project_report).set({ free_period_start: null }).where(stamped);
    return false;
  }
  return withAllowanceLock(db, a, async (tx) => {
    const cleared = await tx
      .update(project_report)
      .set({ free_period_start: null })
      .where(stamped)
      .returning({ id: project_report.id });
    if (cleared.length === 0) return false;
    await giveBack(tx, a, "reports", 1);
    return true;
  });
}
