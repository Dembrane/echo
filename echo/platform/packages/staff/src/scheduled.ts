import { pyIso } from "@echo/billing";
import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";

const { scheduled_task } = schema;

/**
 * The durable one-shot timers of support access, kept in the scheduled_task table the
 * old API writes, so staff can still inspect and cancel them and old and new runners
 * agree during cutover. Each namespace claims only its own task types.
 */
export const SUPPORT_TASKS = {
  revokeStaffSupport: "revoke_staff_support",
  expireSupportRequest: "expire_support_access_request",
  supportToggleReminder: "support_toggle_reminder",
} as const;

/** A row left processing this long is presumed crashed and rescheduled. */
const STALE_CLAIM_MS = 15 * 60_000;

export async function scheduleTask(
  db: Db,
  taskType: string,
  scheduledAt: Date,
  payload: Record<string, unknown>,
  now: Date,
): Promise<string> {
  const id = newId();
  await db.insert(scheduled_task).values({
    id,
    task_type: taskType,
    payload,
    scheduled_at: pyIso(scheduledAt),
    status: "scheduled",
    attempts: 0,
    created_at: pyIso(now),
    updated_at: pyIso(now),
  });
  return id;
}

/** Cancels still-scheduled tasks of a type whose payload has every key/value in `match`. */
export async function cancelPendingTasks(
  db: Db,
  taskType: string,
  match: Record<string, unknown>,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({ id: scheduled_task.id, payload: scheduled_task.payload })
    .from(scheduled_task)
    .where(and(eq(scheduled_task.task_type, taskType), eq(scheduled_task.status, "scheduled")))
    .orderBy(asc(scheduled_task.id));
  let n = 0;
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (!Object.entries(match).every(([k, v]) => p[k] === v)) continue;
    await db
      .update(scheduled_task)
      .set({ status: "cancelled", updated_at: pyIso(now) })
      .where(eq(scheduled_task.id, r.id));
    n += 1;
  }
  return n;
}

export interface ClaimedTask {
  readonly id: string;
  readonly task_type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Rescues stale claims, then claims due rows of the given types (oldest first) with
 * SKIP LOCKED, so two runners never take the same row.
 */
export async function claimDueTasks(
  db: Db,
  types: readonly string[],
  now: Date,
  limit = 50,
): Promise<ClaimedTask[]> {
  const iso = pyIso(now);
  await db
    .update(scheduled_task)
    .set({ status: "scheduled", claimed_at: null, updated_at: iso })
    .where(
      and(
        inArray(scheduled_task.task_type, [...types]),
        eq(scheduled_task.status, "processing"),
        lt(scheduled_task.claimed_at, pyIso(new Date(now.getTime() - STALE_CLAIM_MS))),
      ),
    );
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: scheduled_task.id,
        task_type: scheduled_task.task_type,
        payload: scheduled_task.payload,
      })
      .from(scheduled_task)
      .where(
        and(
          inArray(scheduled_task.task_type, [...types]),
          eq(scheduled_task.status, "scheduled"),
          lte(scheduled_task.scheduled_at, iso),
        ),
      )
      .orderBy(asc(scheduled_task.scheduled_at))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    await tx
      .update(scheduled_task)
      .set({
        status: "processing",
        claimed_at: iso,
        attempts: sql`coalesce(${scheduled_task.attempts}, 0) + 1`,
        updated_at: iso,
      })
      .where(
        inArray(
          scheduled_task.id,
          due.map((d) => d.id),
        ),
      );
    return due.map((d) => ({ ...d, payload: (d.payload ?? {}) as Record<string, unknown> }));
  });
}

export async function settleTask(
  db: Db,
  id: string,
  error: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(scheduled_task)
    .set(
      error === null
        ? { status: "completed", error: null, updated_at: pyIso(now) }
        : { status: "failed", error: error.slice(0, 5000), updated_at: pyIso(now) },
    )
    .where(eq(scheduled_task.id, id));
}
