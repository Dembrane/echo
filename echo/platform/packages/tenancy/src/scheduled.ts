import type { Db } from "@echo/db";
import { iso } from "./db";
import {
  claimDueTasks,
  overdueSupportMemberships,
  resetStaleClaims,
  type ScheduledTaskType,
  scheduleTask,
  settleTask,
  supportMemberships,
  supportRequest,
  updateSupportRequest,
} from "./storage/support";
import { membershipById, updateMembership, workspaceById } from "./storage/tenancy";
import {
  maybeAutoDisable,
  membershipExpired,
  REMINDER_INTERVAL_MS,
  recordSupportEvent,
  type SupportDeps,
  sendSupportNotice,
} from "./support";

/**
 * The scheduled_task types this namespace runs. Other namespaces own the rest of the table
 * (reports, canvas and popcorn ticks) and claim only their own types.
 */
const TYPES: readonly ScheduledTaskType[] = [
  "revoke_staff_support",
  "expire_support_access_request",
  "support_toggle_reminder",
];

/** A claim older than this is presumed crashed and handed out again. */
const STALE_CLAIM_MS = 15 * 60_000;

export interface RunnerDeps extends SupportDeps {
  readonly db: Db;
  readonly now?: () => Date;
}

const nowOf = (d: RunnerDeps) => (d.now ? d.now() : new Date());

/** Ends one staff support grant, then turns consent off if it was the last live session. */
export async function revokeStaffSupport(d: RunnerDeps, membershipId: string, workspaceId: string) {
  const now = nowOf(d);
  return d.db.transaction(async (tx) => {
    const m = await membershipById(tx, membershipId);
    // A deleted id can be reactivated as a real member; never strip that.
    if (!m || m.deleted_at || m.source !== "staff_support") return false;
    await updateMembership(tx, membershipId, { deleted_at: iso(now), updated_at: iso(now) });
    await recordSupportEvent(d, tx, now, {
      workspaceId,
      event: "staff_auto_revoked",
      staff: m.user_id,
      params: { membership_id: membershipId },
      notify: false,
    });
    if (!(await maybeAutoDisable(d, tx, now, workspaceId)))
      await sendSupportNotice(d, tx, now, {
        workspaceId,
        event: "staff_auto_revoked",
        staff: m.user_id,
      });
    return true;
  });
}

async function expireSupportRequest(d: RunnerDeps, requestId: string) {
  const now = nowOf(d);
  return d.db.transaction(async (tx) => {
    const req = await supportRequest(tx, requestId);
    // An approval or denial that beat the timer wins.
    if (req?.status !== "pending") return false;
    await updateSupportRequest(tx, requestId, { status: "expired", resolved_at: iso(now) });
    await recordSupportEvent(d, tx, now, {
      workspaceId: req.workspace_id,
      event: "request_expired",
      staff: req.requested_by,
      params: { request_id: requestId },
    });
    return true;
  });
}

/** Weekly nudge while consent stays on and nobody joined; re-arms itself until consent is off. */
async function supportToggleReminder(d: RunnerDeps, workspaceId: string) {
  const now = nowOf(d);
  await d.db.transaction(async (tx) => {
    const ws = await workspaceById(tx, workspaceId);
    if (!ws || ws.deleted_at || !ws.allow_support_access) return;
    const live = (await supportMemberships(tx, workspaceId)).filter(
      (r) => !membershipExpired(r.expires_at, now),
    );
    if (!live.length) await recordSupportEvent(d, tx, now, { workspaceId, event: "reminder_sent" });
    await scheduleTask(
      tx,
      iso(now),
      "support_toggle_reminder",
      iso(new Date(now.getTime() + REMINDER_INTERVAL_MS)),
      { workspace_id: workspaceId },
    );
  });
}

/** Claims and runs every due task of this namespace's types; a failing one is marked and skipped. */
export async function runDueScheduledTasks(d: RunnerDeps): Promise<number> {
  const now = nowOf(d);
  await resetStaleClaims(d.db, iso(now), iso(new Date(now.getTime() - STALE_CLAIM_MS)), TYPES);
  const due = await claimDueTasks(d.db, iso(now), TYPES, 50);
  for (const row of due) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    let error: string | null = null;
    try {
      if (row.task_type === "revoke_staff_support") {
        if (!p.workspace_id || !p.membership_id)
          throw new Error("revoke_staff_support payload missing workspace_id/membership_id");
        await revokeStaffSupport(d, String(p.membership_id), String(p.workspace_id));
      } else if (row.task_type === "expire_support_access_request") {
        if (!p.request_id)
          throw new Error("expire_support_access_request payload missing request_id");
        await expireSupportRequest(d, String(p.request_id));
      } else if (row.task_type === "support_toggle_reminder") {
        if (!p.workspace_id)
          throw new Error("support_toggle_reminder payload missing workspace_id");
        await supportToggleReminder(d, String(p.workspace_id));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await settleTask(d.db, row.id, iso(nowOf(d)), error);
  }
  return due.length;
}

/** Catch-up for grants whose revoke row was lost or cancelled by mistake. */
export async function expireOverdueSupportMemberships(d: RunnerDeps): Promise<number> {
  const rows = await overdueSupportMemberships(d.db, iso(nowOf(d)));
  let n = 0;
  for (const r of rows) if (await revokeStaffSupport(d, r.id, r.workspace_id)) n++;
  return n;
}
