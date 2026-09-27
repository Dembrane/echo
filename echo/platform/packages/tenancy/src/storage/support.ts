import { newId } from "@echo/core";
import { schema } from "@echo/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { type Conn, isUuid } from "../db";

const { support_access_event, support_access_request, scheduled_task, workspace_membership } =
  schema;

export async function insertSupportEvent(
  db: Conn,
  row: {
    workspace_id: string;
    event_code: string;
    actor_user_id: string | null;
    staff_user_id: string | null;
    params: Record<string, unknown>;
    created_at: string;
  },
) {
  const id = newId();
  await db.insert(support_access_event).values({ id, ...row });
  return id;
}

/** Newest first, one extra row so the caller knows whether another page exists. */
export async function supportEvents(db: Conn, workspaceId: string, limit: number, offset: number) {
  return db
    .select()
    .from(support_access_event)
    .where(eq(support_access_event.workspace_id, workspaceId))
    .orderBy(desc(support_access_event.created_at))
    .limit(limit)
    .offset(offset);
}

export async function supportRequest(db: Conn, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(support_access_request)
    .where(eq(support_access_request.id, id))
    .limit(1);
  return row ?? null;
}

/** Newest first for the list; in primary key order when every one is about to be resolved. */
export async function pendingSupportRequests(
  db: Conn,
  workspaceId: string,
  opts: { byId?: boolean } = {},
) {
  return db
    .select()
    .from(support_access_request)
    .where(
      and(
        eq(support_access_request.workspace_id, workspaceId),
        eq(support_access_request.status, "pending"),
      ),
    )
    .orderBy(opts.byId ? asc(support_access_request.id) : desc(support_access_request.created_at));
}

export async function updateSupportRequest(
  db: Conn,
  id: string,
  patch: Partial<typeof support_access_request.$inferInsert>,
) {
  await db.update(support_access_request).set(patch).where(eq(support_access_request.id, id));
}

/** Live staff support rows of a workspace (deleted ones excluded, expired ones included). */
export async function supportMemberships(db: Conn, workspaceId: string) {
  return db
    .select({ id: workspace_membership.id, expires_at: workspace_membership.expires_at })
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.workspace_id, workspaceId),
        eq(workspace_membership.source, "staff_support"),
        isNull(workspace_membership.deleted_at),
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

/** Staff support rows whose 24 hours have passed but which are still live. */
export async function overdueSupportMemberships(db: Conn, nowIso: string) {
  return db
    .select({ id: workspace_membership.id, workspace_id: workspace_membership.workspace_id })
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.source, "staff_support"),
        isNull(workspace_membership.deleted_at),
        isNotNull(workspace_membership.expires_at),
        lt(workspace_membership.expires_at, nowIso),
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

// ── scheduled_task: durable one-shot timers ─────────────────────────────

export type ScheduledTaskType =
  | "revoke_staff_support"
  | "support_toggle_reminder"
  | "expire_support_access_request";

export async function scheduleTask(
  db: Conn,
  nowIso: string,
  taskType: ScheduledTaskType,
  scheduledAt: string,
  payload: Record<string, unknown>,
) {
  await db.insert(scheduled_task).values({
    id: newId(),
    task_type: taskType,
    payload,
    scheduled_at: scheduledAt,
    status: "scheduled",
    attempts: 0,
    created_at: nowIso,
    updated_at: nowIso,
  });
}

/** Cancels still-scheduled tasks of a type whose payload carries every given key and value. */
export async function cancelPendingTasks(
  db: Conn,
  nowIso: string,
  taskType: ScheduledTaskType,
  match: Record<string, unknown>,
) {
  const rows = await db
    .select({ id: scheduled_task.id, payload: scheduled_task.payload })
    .from(scheduled_task)
    .where(and(eq(scheduled_task.task_type, taskType), eq(scheduled_task.status, "scheduled")))
    .orderBy(asc(scheduled_task.id));
  const ids = rows
    .filter((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return Object.entries(match).every(([k, v]) => p[k] === v);
    })
    .map((r) => r.id);
  if (ids.length)
    await db
      .update(scheduled_task)
      .set({ status: "cancelled", updated_at: nowIso })
      .where(inArray(scheduled_task.id, ids));
  return ids.length;
}

/** Claims due rows of the given types by moving them to processing; oldest due first. */
export async function claimDueTasks(
  db: Conn,
  nowIso: string,
  types: readonly ScheduledTaskType[],
  limit: number,
) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(scheduled_task)
      .where(
        and(
          eq(scheduled_task.status, "scheduled"),
          lte(scheduled_task.scheduled_at, nowIso),
          inArray(scheduled_task.task_type, [...types]),
        ),
      )
      .orderBy(asc(scheduled_task.scheduled_at))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const row of due)
      await tx
        .update(scheduled_task)
        .set({
          status: "processing",
          claimed_at: nowIso,
          attempts: (row.attempts ?? 0) + 1,
          updated_at: nowIso,
        })
        .where(eq(scheduled_task.id, row.id));
    return due;
  });
}

/** Rows left in processing by a crashed runner go back to scheduled. */
export async function resetStaleClaims(
  db: Conn,
  nowIso: string,
  staleBeforeIso: string,
  types: readonly ScheduledTaskType[],
) {
  const rows = await db
    .update(scheduled_task)
    .set({ status: "scheduled", claimed_at: null, updated_at: nowIso })
    .where(
      and(
        eq(scheduled_task.status, "processing"),
        lt(scheduled_task.claimed_at, staleBeforeIso),
        inArray(scheduled_task.task_type, [...types]),
      ),
    )
    .returning({ id: scheduled_task.id });
  return rows.length;
}

export async function settleTask(db: Conn, id: string, nowIso: string, error: string | null) {
  await db
    .update(scheduled_task)
    .set(
      error === null
        ? { status: "completed", error: null, updated_at: nowIso }
        : { status: "failed", error: error.slice(0, 5000), updated_at: nowIso },
    )
    .where(eq(scheduled_task.id, id));
}
