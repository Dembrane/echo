import { ConflictError, newId } from "@dembrane/core";
import { localesOfAppUsers } from "@dembrane/i18n";
import { type Conn, iso } from "./db";
import { supportAccessEmail } from "./emails";
import { emailJob, type JobSink } from "./jobs";
import { dashboardPath } from "./links";
import { workspaceAdmins } from "./members";
import { emit, emitToAll } from "./notify";
import { appUser, appUsersByIds } from "./storage/people";
import {
  cancelPendingTasks,
  insertSupportEvent,
  scheduleTask,
  supportMemberships,
  updateSupportRequest,
} from "./storage/support";
import {
  allMembershipsForPair,
  insertMembership,
  membershipById,
  updateMembership,
  updateWorkspace,
  workspaceById,
} from "./storage/tenancy";

export const REQUEST_TTL_MS = 7 * 86_400_000;
export const REMINDER_INTERVAL_MS = 7 * 86_400_000;
export const SUPPORT_ACCESS_TTL_MS = 24 * 3_600_000;

export type SupportEvent =
  | "toggle_enabled"
  | "toggle_disabled"
  | "toggle_auto_disabled"
  | "request_created"
  | "request_approved"
  | "request_denied"
  | "request_expired"
  | "request_cancelled"
  | "staff_joined"
  | "staff_extended"
  | "staff_left"
  | "staff_auto_revoked"
  | "reminder_sent";

/** What support access needs besides the transaction: mail goes out through the queue. */
export interface SupportDeps {
  readonly jobs: JobSink;
  readonly dashboardUrl: string;
}

export interface EventInput {
  workspaceId: string;
  event: SupportEvent;
  actor?: string | null;
  staff?: string | null;
  params?: Record<string, unknown>;
  notify?: boolean;
}

/**
 * The one choke point for support access lifecycle changes: the audit row, then the inbox
 * notice and email. Everything is written in the caller's transaction.
 */
export async function recordSupportEvent(d: SupportDeps, tx: Conn, now: Date, e: EventInput) {
  const id = await insertSupportEvent(tx, {
    workspace_id: e.workspaceId,
    event_code: e.event,
    actor_user_id: e.actor ?? null,
    staff_user_id: e.staff ?? null,
    params: e.params ?? {},
    created_at: iso(now),
  });
  if (e.notify !== false) await sendSupportNotice(d, tx, now, e);
  return id;
}

/**
 * Emails the support notice to `userIds`, one email per language: each person reads it in
 * the language their dashboard is set to, English when they never chose one.
 */
async function mail(
  d: SupportDeps,
  tx: Conn,
  userIds: readonly string[],
  wsName: string,
  t: Parameters<typeof supportAccessEmail>[1],
) {
  const rows = await appUsersByIds(tx, userIds);
  const langs = await localesOfAppUsers(tx, userIds);
  const byLocale = new Map<string, Set<string>>();
  for (const r of rows) {
    const email = (r.email ?? "").trim();
    if (!email) continue;
    const l = langs.get(r.id) ?? "en-US";
    byLocale.set(l, (byLocale.get(l) ?? new Set()).add(email));
  }
  for (const [locale, to] of [...byLocale].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rendered = supportAccessEmail(wsName, t, locale);
    await d.jobs.enqueue(
      emailJob,
      { to: [...to].sort(), ...rendered, tags: ["support_access"] },
      { tx },
    );
  }
}

/** The notice and email for one lifecycle event; the customer's own toggle flips are audit only. */
export async function sendSupportNotice(d: SupportDeps, tx: Conn, now: Date, e: EventInput) {
  if (e.event === "toggle_enabled" || e.event === "toggle_disabled") return;
  const ws = await workspaceById(tx, e.workspaceId);
  if (!ws) return;
  const wsName = ws.name || "your workspace";
  const orgId = ws.org_id;
  const settingsUrl = dashboardPath(d.dashboardUrl, `/w/${e.workspaceId}/settings/general`);
  const p = e.params ?? {};
  const staffName = async () =>
    (e.staff ? (await appUser(tx, e.staff))?.display_name : "") || "dembrane staff";
  const base = {
    orgId,
    workspaceId: e.workspaceId,
    action: "NAVIGATE_WORKSPACE_SETTINGS" as const,
  };

  switch (e.event) {
    case "request_created": {
      const name = await staffName();
      const note = String(p.message ?? "").trim();
      const admins = await workspaceAdmins(tx, e.workspaceId);
      const title = `dembrane staff requested access to ${wsName}`;
      let message = `${name} asked to join this workspace for support.`;
      if (note) message = `${message} Note: ${note}`;
      await emitToAll(tx, now, admins, {
        ...base,
        event: "SUPPORT_ACCESS_REQUESTED",
        title,
        message: `${message} Approve or deny in workspace settings.`,
        actor: e.staff ?? null,
        params: { request_id: p.request_id ?? null },
      });
      await mail(d, tx, admins, wsName, {
        kind: "request",
        staffName: name,
        note,
        settingsUrl,
      });
      return;
    }
    case "staff_joined": {
      const name = await staffName();
      const admins = await workspaceAdmins(tx, e.workspaceId);
      const title = `dembrane staff joined ${wsName} for support`;
      await emitToAll(tx, now, admins, {
        ...base,
        event: "SUPPORT_STAFF_JOINED",
        title,
        message: "Access ends automatically after 24 hours.",
        actor: e.staff ?? null,
      });
      await mail(d, tx, admins, wsName, {
        kind: "joined",
        staffName: name,
        settingsUrl,
      });
      return;
    }
    case "staff_extended":
      await emitToAll(tx, now, await workspaceAdmins(tx, e.workspaceId), {
        ...base,
        event: "SUPPORT_STAFF_EXTENDED",
        title: `dembrane staff extended their support session in ${wsName}`,
        message: "The session ends 24 hours from now.",
        actor: e.staff ?? null,
      });
      return;
    case "staff_left":
    case "staff_auto_revoked":
      await emitToAll(tx, now, await workspaceAdmins(tx, e.workspaceId), {
        ...base,
        event: "SUPPORT_STAFF_LEFT",
        title: `A dembrane staff member left ${wsName}`,
        actor: e.staff ?? null,
      });
      return;
    case "toggle_auto_disabled": {
      const admins = await workspaceAdmins(tx, e.workspaceId);
      const title = `Support access to ${wsName} turned off`;
      await emitToAll(tx, now, admins, {
        ...base,
        event: "SUPPORT_ACCESS_ENDED",
        title,
        message:
          "The support session ended and staff access was turned off. Turn it back on in workspace settings if you need more help.",
      });
      await mail(d, tx, admins, wsName, {
        kind: "ended",
        settingsUrl,
      });
      return;
    }
    case "reminder_sent": {
      const admins = await workspaceAdmins(tx, e.workspaceId);
      const title = `Support access to ${wsName} is still on`;
      await emitToAll(tx, now, admins, {
        ...base,
        event: "SUPPORT_ACCESS_REMINDER",
        title,
        message:
          "No staff joined in the last 7 days. Turn it off in workspace settings if you no longer need help.",
      });
      await mail(d, tx, admins, wsName, {
        kind: "reminder",
        settingsUrl,
      });
      return;
    }
    case "request_approved":
    case "request_denied": {
      if (!e.staff) return;
      const decision = e.event === "request_approved" ? "approved" : "denied";
      const title = `Access request for ${wsName} ${decision}`;
      await emit(tx, now, e.staff, {
        event: decision === "approved" ? "SUPPORT_REQUEST_APPROVED" : "SUPPORT_REQUEST_DENIED",
        title,
        message: decision === "approved" ? "You have admin access for 24 hours." : null,
        actor: e.actor ?? null,
        orgId,
        workspaceId: e.workspaceId,
        params: { request_id: p.request_id ?? null },
      });
      await mail(d, tx, [e.staff], wsName, {
        kind: "resolved",
        decision,
        workspaceUrl: dashboardPath(d.dashboardUrl, `/w/${e.workspaceId}/home`),
      });
      return;
    }
    case "request_expired":
      if (!e.staff) return;
      await emit(tx, now, e.staff, {
        event: "SUPPORT_REQUEST_EXPIRED",
        title: `Access request for ${wsName} expired`,
        orgId,
        workspaceId: e.workspaceId,
        params: { request_id: p.request_id ?? null },
      });
      return;
    case "request_cancelled":
      // Only the toggle-on supersede tells the requester; a self-cancel is silent.
      if (p.reason !== "toggle_enabled" || !e.staff) return;
      await emit(tx, now, e.staff, {
        event: "SUPPORT_REQUEST_SUPERSEDED",
        title: `Support access for ${wsName} is now on`,
        message: "You can join directly from the admin console.",
        orgId,
        workspaceId: e.workspaceId,
        params: { request_id: p.request_id ?? null },
      });
      return;
  }
}

/**
 * Creates, reactivates or extends a 24 hour staff support membership and re-arms its revoke
 * timer. A staff member who is already a real member keeps that row untouched.
 */
export async function grantSupportMembership(
  tx: Conn,
  now: Date,
  o: { workspaceId: string; appUserId: string; orgId: string | null },
): Promise<{
  status: "already_member" | "extended" | "joined";
  membershipId: string;
  expiresAt: string | null;
}> {
  const expires = iso(new Date(now.getTime() + SUPPORT_ACCESS_TTL_MS));
  const rows = await allMembershipsForPair(tx, o.workspaceId, o.appUserId);
  const active = rows.find((r) => r.deleted_at === null);
  const deleted = rows.find((r) => r.deleted_at !== null);
  if (active && active.source !== "staff_support")
    return { status: "already_member", membershipId: active.id, expiresAt: null };
  let membershipId: string;
  let status: "extended" | "joined";
  if (active) {
    membershipId = active.id;
    await updateMembership(tx, membershipId, { expires_at: expires, updated_at: iso(now) });
    status = "extended";
  } else if (deleted) {
    membershipId = deleted.id;
    await updateMembership(tx, membershipId, {
      deleted_at: null,
      role: "admin",
      source: "staff_support",
      expires_at: expires,
      updated_at: iso(now),
    });
    status = "joined";
  } else {
    membershipId = newId();
    await insertMembership(tx, {
      id: membershipId,
      workspace_id: o.workspaceId,
      user_id: o.appUserId,
      role: "admin",
      source: "staff_support",
      expires_at: expires,
      created_at: iso(now),
      updated_at: iso(now),
    });
    status = "joined";
  }
  if (!membershipId) throw new ConflictError("member.changed_concurrently");
  await cancelPendingTasks(tx, iso(now), "revoke_staff_support", { membership_id: membershipId });
  await scheduleTask(tx, iso(now), "revoke_staff_support", expires, {
    workspace_id: o.workspaceId,
    membership_id: membershipId,
    org_id: o.orgId,
  });
  return { status, membershipId, expiresAt: expires };
}

/** Toggle turned on: pending requests are moot (staff may join directly); tell each requester. */
export async function supersedePendingRequests(
  d: SupportDeps,
  tx: Conn,
  now: Date,
  workspaceId: string,
  actor: string,
  pending: readonly { id: string; requested_by: string }[],
) {
  for (const row of pending) {
    await updateSupportRequest(tx, row.id, {
      status: "cancelled",
      resolved_at: iso(now),
      resolved_by: actor,
    });
    await cancelPendingTasks(tx, iso(now), "expire_support_access_request", { request_id: row.id });
    await recordSupportEvent(d, tx, now, {
      workspaceId,
      event: "request_cancelled",
      actor,
      staff: row.requested_by,
      params: { request_id: row.id, reason: "toggle_enabled" },
    });
  }
}

function expired(expiresAt: string | null, now: Date) {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

/** When no live support session remains, the consent toggle turns itself off. */
export async function maybeAutoDisable(
  d: SupportDeps,
  tx: Conn,
  now: Date,
  workspaceId: string,
): Promise<boolean> {
  const ws = await workspaceById(tx, workspaceId);
  if (!ws?.allow_support_access) return false;
  const live = (await supportMemberships(tx, workspaceId)).filter(
    (r) => !expired(r.expires_at, now),
  );
  if (live.length) return false;
  await updateWorkspace(tx, workspaceId, { allow_support_access: false, updated_at: iso(now) });
  await cancelPendingTasks(tx, iso(now), "support_toggle_reminder", { workspace_id: workspaceId });
  await recordSupportEvent(d, tx, now, { workspaceId, event: "toggle_auto_disabled" });
  return true;
}

/**
 * Ends every live staff support grant on a workspace: the customer turned consent off, so
 * access stops now instead of lasting up to 24 more hours (spec H-13).
 */
export async function revokeAllSupport(d: SupportDeps, tx: Conn, now: Date, workspaceId: string) {
  for (const row of await supportMemberships(tx, workspaceId)) {
    await updateMembership(tx, row.id, { deleted_at: iso(now), updated_at: iso(now) });
    await cancelPendingTasks(tx, iso(now), "revoke_staff_support", { membership_id: row.id });
    const m = await membershipById(tx, row.id);
    await recordSupportEvent(d, tx, now, {
      workspaceId,
      event: "staff_auto_revoked",
      staff: m?.user_id ?? null,
      params: { membership_id: row.id },
      notify: false,
    });
  }
}

export { expired as membershipExpired };
