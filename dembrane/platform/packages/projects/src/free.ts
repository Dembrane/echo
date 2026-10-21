import {
  type AllowanceAccount,
  allowanceForCountedProject,
  allowanceForProject,
  freeLimitError,
  freeLimits,
  giveBack,
  take,
  withAllowanceLock,
} from "@dembrane/allowance";
import { ConflictError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

const { project_report } = schema;

// Takes the period's report; null when the project is unlimited or a sample.
export async function takeFreeReport(
  db: Db,
  projectId: string,
  now: Date,
): Promise<AllowanceAccount | null> {
  const a = await allowanceForCountedProject(db, projectId, now);
  if (!a) return null;
  const limits = await freeLimits(db);
  const t = await take(db, a, "reports", 1, limits.reports_month);
  if (!t.ok) throw freeLimitError("report", { used: t.used, cap: t.limit });
  return a;
}

// Gives back the stamp of a run that errored before saving, or was cancelled before it ran, once.
export async function refundFreeReport(db: Db, reportId: number, now: Date): Promise<boolean> {
  const id = BigInt(reportId);
  const ended = inArray(project_report.status, ["error", "cancelled"]);
  const [r] = await db
    .select({
      projectId: project_report.project_id,
      stamp: project_report.free_period_start,
      stampMs: sql<string>`(extract(epoch from ${project_report.free_period_start}) * 1000)::bigint`,
    })
    .from(project_report)
    .where(and(eq(project_report.id, id), isNotNull(project_report.free_period_start), ended));
  if (!r) return false;
  // Only the row as read: a concurrent reschedule may have restamped it.
  const asRead = and(
    eq(project_report.id, id),
    ended,
    sql`${project_report.free_period_start} = ${r.stamp}::timestamptz`,
  );
  const a = r.projectId ? await allowanceForProject(db, r.projectId, now) : null;
  if (!a || Number(r.stampMs) !== a.periodStart.getTime()) {
    await db.update(project_report).set({ free_period_start: null }).where(asRead);
    return false;
  }
  return withAllowanceLock(db, a, async (tx) => {
    const cleared = await tx
      .update(project_report)
      .set({ free_period_start: null })
      .where(asRead)
      .returning({ id: project_report.id });
    if (cleared.length === 0) return false;
    await giveBack(tx, a, "reports", 1);
    return true;
  });
}

/**
 * Cancels a scheduled report; a free one gives back this period's report in the same lock.
 * False when the report was not scheduled.
 */
export async function cancelScheduledReport(
  db: Db,
  projectId: string,
  reportId: number,
  now: Date,
  cancelTasks: (tx: Db) => Promise<unknown>,
): Promise<boolean> {
  const a = await allowanceForProject(db, projectId, now);
  const id = BigInt(reportId);
  const cancel = async (tx: Db) => {
    const [r] = await tx
      .select({
        stampMs: sql<
          string | null
        >`(extract(epoch from ${project_report.free_period_start}) * 1000)::bigint`,
      })
      .from(project_report)
      .where(and(eq(project_report.id, id), eq(project_report.status, "scheduled")))
      .for("update");
    if (!r) return false;
    await tx
      .update(project_report)
      .set({ status: "cancelled", free_period_start: null, date_updated: now.toISOString() })
      .where(eq(project_report.id, id));
    await cancelTasks(tx);
    if (a && r.stampMs !== null && Number(r.stampMs) === a.periodStart.getTime())
      await giveBack(tx, a, "reports", 1);
    return true;
  };
  // Allowance lock before the row lock, as chargeReportChange takes them.
  return a ? withAllowanceLock(db, a, cancel) : db.transaction((tx) => cancel(tx as unknown as Db));
}

/** Statuses of a report that has not run yet or is running. */
const UNRUN = new Set(["scheduled", "draft", "cancelled"]);

export type ReportCharge = {
  account: AllowanceAccount;
  previous: string | null;
  wrote: string | null;
  status: string;
};

/**
 * Charges a status or schedule change of a free report: one that will generate again takes the
 * period's report unless this period's stamp covers a run that has not happened yet, or one
 * that errored and is not refunded yet; a report that ran, moved back to draft or cancelled,
 * loses its stamp. `undo` is null when nothing changed.
 */
export async function chargeReportChange(
  db: Db,
  projectId: string,
  reportId: number,
  nextStatus: string | null,
  now: Date,
): Promise<{ free: boolean; undo: ReportCharge | null }> {
  const a = await allowanceForCountedProject(db, projectId, now);
  if (!a) return { free: false, undo: null };
  const limits = await freeLimits(db);
  const id = BigInt(reportId);
  const undo = await withAllowanceLock(db, a, async (tx): Promise<ReportCharge | null> => {
    const [r] = await tx
      .select({
        status: project_report.status,
        stamp: project_report.free_period_start,
        stampMs: sql<
          string | null
        >`(extract(epoch from ${project_report.free_period_start}) * 1000)::bigint`,
      })
      .from(project_report)
      .where(eq(project_report.id, id))
      .for("update");
    if (!r) return null;
    const unrun = UNRUN.has(r.status);
    const status = nextStatus ?? r.status;
    const current = r.stampMs !== null && Number(r.stampMs) === a.periodStart.getTime();
    // A failed run whose refund has not landed yet: its stamp is still owed back.
    const owed = r.status === "error" && current;
    if (status === "scheduled") {
      // A stamped draft is a run in progress; a second one would overlap it.
      if (r.status === "draft" && r.stamp !== null)
        throw new ConflictError("report.already_generating");
      if ((unrun || owed) && current) return null;
      const t = await take(tx, a, "reports", 1, limits.reports_month);
      if (!t.ok) throw freeLimitError("report", { used: t.used, cap: t.limit });
      const wrote = a.periodStart.toISOString();
      // The status moves with the stamp, so a concurrent change sees this one as unrun.
      await tx
        .update(project_report)
        .set({ free_period_start: wrote, status })
        .where(eq(project_report.id, id));
      return { account: a, previous: r.stamp, wrote, status: r.status };
    }
    // A report that ran, or a running draft moved off draft by hand, keeps no stamp to reuse;
    // an owed one cancelled keeps it for the cancel refund.
    const ran = owed
      ? status !== "cancelled" && status !== "error"
      : (!unrun && (UNRUN.has(status) || status === "error")) ||
        (r.status === "draft" && status !== "draft");
    if (ran && r.stamp !== null) {
      await tx
        .update(project_report)
        .set({ free_period_start: null, status })
        .where(eq(project_report.id, id));
      return { account: a, previous: r.stamp, wrote: null, status: r.status };
    }
    return null;
  });
  return { free: true, undo };
}

// Undoes chargeReportChange when the change did not happen, if nothing moved the stamp since.
export async function undoReportCharge(db: Db, reportId: number, c: ReportCharge): Promise<void> {
  await withAllowanceLock(db, c.account, async (tx) => {
    const restored = await tx
      .update(project_report)
      .set({ free_period_start: c.previous, status: c.status })
      .where(
        and(
          eq(project_report.id, BigInt(reportId)),
          c.wrote === null
            ? isNull(project_report.free_period_start)
            : sql`${project_report.free_period_start} = ${c.wrote}::timestamptz`,
        ),
      )
      .returning({ id: project_report.id });
    if (restored.length && c.wrote !== null) await giveBack(tx, c.account, "reports", 1);
  });
}
