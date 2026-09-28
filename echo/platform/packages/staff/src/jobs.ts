import type { Billing } from "@dembrane/billing";
import type { Db } from "@dembrane/db";
import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { z } from "zod";
import { claimDueTasks, SUPPORT_TASKS, scheduleTask, settleTask } from "./scheduled";
import { staffStorage } from "./storage";
import { SupportAccess } from "./support";

/**
 * Support access timers. The per-join revoke, the request expiry and the weekly toggle
 * reminder are rows in scheduled_task (claimed every minute, like the old runner); the
 * 15-minute sweep revokes any support row whose expiry passed without its timer.
 */
const tick = z.object({});
const opts = { policy: "singleton" as const, retryLimit: 2, expireInSeconds: 5 * 60 };
export const supportTimers = defineJob("staff.support-timers", tick, opts);
export const expireSupportMemberships = defineJob("staff.expire-support", tick, opts);

export const STAFF_SCHEDULES: readonly [JobDefinition, string][] = [
  [supportTimers, "* * * * *"],
  [expireSupportMemberships, "*/15 * * * *"],
];

export interface StaffJobDeps {
  readonly db: Db;
  readonly billing: Billing;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly dashboardUrl: string;
  readonly clock?: () => Date;
}

function supportFor(d: StaffJobDeps) {
  return new SupportAccess({
    db: d.db,
    storage: staffStorage(d.db),
    billingStore: d.billing.store,
    notifier: d.billing.notifier,
    mailer: d.mailer,
    logger: d.logger,
    dashboardUrl: d.dashboardUrl,
    clock: d.clock ?? (() => new Date()),
  });
}

/** Claims due support timers and runs each; one failure marks that row failed and moves on. */
export async function runSupportTimers(d: StaffJobDeps): Promise<void> {
  const clock = d.clock ?? (() => new Date());
  const support = supportFor(d);
  const due = await claimDueTasks(d.db, Object.values(SUPPORT_TASKS), clock());
  for (const t of due) {
    try {
      const p = t.payload;
      if (t.task_type === SUPPORT_TASKS.revokeStaffSupport) {
        if (!p.workspace_id || !p.membership_id)
          throw new Error("revoke_staff_support payload missing workspace_id/membership_id");
        await support.revoke(String(p.workspace_id), String(p.membership_id));
      } else if (t.task_type === SUPPORT_TASKS.expireSupportRequest) {
        if (!p.request_id)
          throw new Error("expire_support_access_request payload missing request_id");
        await support.expireRequest(String(p.request_id));
      } else {
        if (!p.workspace_id)
          throw new Error("support_toggle_reminder payload missing workspace_id");
        const next = await support.reminderTick(String(p.workspace_id));
        if (next)
          await scheduleTask(
            d.db,
            SUPPORT_TASKS.supportToggleReminder,
            next,
            { workspace_id: String(p.workspace_id) },
            clock(),
          );
      }
      await settleTask(d.db, t.id, null, clock());
    } catch (err) {
      d.logger.error({ err, task: t.id, type: t.task_type }, "support timer failed");
      await settleTask(d.db, t.id, err instanceof Error ? err.message : String(err), clock());
    }
  }
}

/** Revokes support rows past their expiry whose timer was lost or cancelled by mistake. */
export async function runExpireSupport(d: StaffJobDeps): Promise<void> {
  const clock = d.clock ?? (() => new Date());
  const support = supportFor(d);
  const rows = await staffStorage(d.db).overdueSupportRows(clock().toISOString());
  for (const r of rows) {
    try {
      await support.revoke(r.workspace_id, r.id);
    } catch (err) {
      d.logger.error({ err, membership: r.id }, "failed to expire staff support membership");
    }
  }
}

export function staffRegistration(d: StaffJobDeps) {
  const handlers: [JobDefinition, () => Promise<void>][] = [
    [supportTimers, () => runSupportTimers(d)],
    [expireSupportMemberships, () => runExpireSupport(d)],
  ];
  return {
    jobs: handlers.map(([j]) => j),
    async register(queue: Queue) {
      for (const [job, run] of handlers) await queue.work(job, { concurrency: 1 }, run);
      for (const [job, cron] of STAFF_SCHEDULES) await queue.schedule(job, cron, {}, "UTC");
    },
  };
}
