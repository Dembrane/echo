import { newId } from "@dembrane/core";
import { type Conn, iso } from "./db";
import {
  insertNotification,
  orgAdminIds,
  projectName,
  staffAppUserIds,
} from "./storage/notifications";
import { orgById, workspaceById } from "./storage/tenancy";

export type NotificationAction =
  | "NONE"
  | "NAVIGATE_WS"
  | "NAVIGATE_PROJECT"
  | "NAVIGATE_ORGANISATION_SETTINGS"
  | "NAVIGATE_WORKSPACE_SETTINGS";

/** Row styling in the inbox; anything unlisted is plain information. */
const SEVERITY: Record<string, "info" | "action_required" | "destructive"> = {
  WORKSPACE_REMOVED: "destructive",
  ORGANISATION_REMOVED: "destructive",
  PROJECT_SHARE_REVOKED: "destructive",
  TIER_DOWNGRADED: "destructive",
  MEMBERSHIP_REQUESTED: "action_required",
  PARTNER_HANDOFF_PENDING: "action_required",
  SUPPORT_ACCESS_REQUESTED: "action_required",
  SUPPORT_ACCESS_REMINDER: "action_required",
};

export interface Notice {
  readonly event: string;
  readonly title: string;
  readonly message?: string | null;
  readonly action?: NotificationAction;
  readonly actor?: string | null;
  readonly orgId?: string | null;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly params?: Record<string, unknown> | null;
}

/**
 * "Org › Workspace › Project", frozen at emit time so a later rename keeps the breadcrumb
 * the person saw. Missing names are skipped rather than invented.
 */
async function scopeOf(db: Conn, n: Notice): Promise<string | null> {
  const parts: string[] = [];
  if (n.orgId) {
    const o = await orgById(db, n.orgId);
    if (o?.name) parts.push(o.name);
  }
  if (n.workspaceId) {
    const w = await workspaceById(db, n.workspaceId);
    if (w?.name) parts.push(w.name);
  }
  if (n.projectId) {
    const name = await projectName(db, n.projectId);
    if (name) parts.push(name);
  }
  return parts.length ? parts.join(" › ") : null;
}

/** One inbox row for one person. Written in the caller's transaction, so it exists only if the action does. */
export async function emit(db: Conn, now: Date, to: string, n: Notice): Promise<void> {
  const at = iso(now);
  await insertNotification(db, {
    id: newId(),
    audience_user_id: to,
    actor_user_id: n.actor ?? null,
    event_code: n.event,
    severity: SEVERITY[n.event] ?? "info",
    action: n.action ?? "NONE",
    title: n.title,
    message: n.message ?? null,
    scope: await scopeOf(db, n),
    params: n.params ?? null,
    ref_org_id: n.orgId ?? null,
    ref_workspace_id: n.workspaceId ?? null,
    ref_project_id: n.projectId ?? null,
    created_at: at,
    updated_at: at,
  });
}

/** The same notice to everyone listed, never to the person who caused it. */
export async function emitToAll(db: Conn, now: Date, audience: readonly string[], n: Notice) {
  for (const uid of audience) {
    if (n.actor && uid === n.actor) continue;
    await emit(db, now, uid, n);
  }
}

export const orgAdmins = orgAdminIds;
export const staffAppUsers = staffAppUserIds;
