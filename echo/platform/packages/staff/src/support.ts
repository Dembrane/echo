import {
  type BillingStore,
  emailsOf,
  type Notifier,
  parseTime,
  pyIso,
  workspaceAdmins,
} from "@dembrane/billing";
import { ConflictError, newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { supportEmail } from "./emails";
import { cancelPendingTasks, SUPPORT_TASKS, scheduleTask } from "./scheduled";
import type { StaffStorage } from "./storage";

export const SUPPORT_ACCESS_TTL_MS = 24 * 3600_000;
export const REQUEST_TTL_MS = 7 * 86_400_000;
export const REMINDER_INTERVAL_MS = 7 * 86_400_000;

export const EVENTS = {
  toggleEnabled: "toggle_enabled",
  toggleDisabled: "toggle_disabled",
  toggleAutoDisabled: "toggle_auto_disabled",
  requestCreated: "request_created",
  requestApproved: "request_approved",
  requestDenied: "request_denied",
  requestExpired: "request_expired",
  requestCancelled: "request_cancelled",
  staffJoined: "staff_joined",
  staffExtended: "staff_extended",
  staffLeft: "staff_left",
  staffAutoRevoked: "staff_auto_revoked",
  reminderSent: "reminder_sent",
} as const;

export interface SupportDeps {
  readonly db: Db;
  readonly storage: StaffStorage;
  readonly billingStore: BillingStore;
  readonly notifier: Notifier;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly dashboardUrl: string;
  readonly clock: () => Date;
}

/** Expiry is authoritative at read time; the revoke timer and sweep are cleanup. */
export function membershipExpired(expiresAt: string | null, now: Date): boolean {
  const d = parseTime(expiresAt);
  return d !== null && d <= now;
}

type GrantStatus = "joined" | "extended" | "already_member";

/**
 * Staff support access (old support_access.py): the 24-hour staff_support membership,
 * its revoke timer, the customer-facing audit trail and the notices that go with it.
 */
export class SupportAccess {
  constructor(private readonly d: SupportDeps) {}

  private get s() {
    return this.d.storage;
  }

  private url(path: string) {
    const base = this.d.dashboardUrl.replace(/\/+$/, "");
    return base ? `${base}${path}` : path;
  }

  /** Creates, reactivates or extends the 24h support row and re-arms its revoke timer. */
  async grant(
    workspaceId: string,
    appUserId: string,
    orgId: string | null,
  ): Promise<{ status: GrantStatus; membershipId: string; expiresIso: string | null }> {
    const now = this.d.clock();
    const expiresAt = new Date(now.getTime() + SUPPORT_ACCESS_TTL_MS);
    const expiresIso = pyIso(expiresAt);
    const rows = await this.s.userMemberships(workspaceId, appUserId);
    const active = rows.find((r) => r.deleted_at === null);
    const deleted = rows.find((r) => r.deleted_at !== null);
    if (active && active.source !== "staff_support")
      return { status: "already_member", membershipId: active.id, expiresIso: null };

    let membershipId: string;
    let status: GrantStatus;
    if (active) {
      membershipId = active.id;
      await this.s.updateMembership(membershipId, { expires_at: expiresIso }, now);
      status = "extended";
    } else {
      status = "joined";
      try {
        if (deleted) {
          membershipId = deleted.id;
          await this.s.updateMembership(
            membershipId,
            { deleted_at: null, role: "admin", source: "staff_support", expires_at: expiresIso },
            now,
          );
        } else {
          membershipId = newId();
          await this.s.insertMembership({
            id: membershipId,
            workspace_id: workspaceId,
            user_id: appUserId,
            role: "admin",
            source: "staff_support",
            expires_at: expiresIso,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          });
        }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent join won: re-read the persisted row so the timer targets a real id.
        const winner = (await this.s.userMemberships(workspaceId, appUserId)).find(
          (r) => r.deleted_at === null,
        );
        if (!winner) throw new ConflictError("member.changed_concurrently");
        if (winner.source !== "staff_support")
          return { status: "already_member", membershipId: winner.id, expiresIso: null };
        membershipId = winner.id;
        await this.s.updateMembership(membershipId, { expires_at: expiresIso }, now);
      }
    }
    await cancelPendingTasks(
      this.d.db,
      SUPPORT_TASKS.revokeStaffSupport,
      { membership_id: membershipId },
      now,
    );
    await scheduleTask(
      this.d.db,
      SUPPORT_TASKS.revokeStaffSupport,
      expiresAt,
      { workspace_id: workspaceId, membership_id: membershipId, org_id: orgId },
      now,
    );
    return { status, membershipId, expiresIso };
  }

  /** Appends one audit row and, unless told not to, sends its notice. Never throws. */
  async record(e: {
    workspaceId: string;
    eventCode: string;
    actorUserId?: string | null;
    staffUserId?: string | null;
    params?: Record<string, unknown>;
    notify?: boolean;
  }): Promise<string | null> {
    let id: string | null = newId();
    try {
      await this.s.insertEvent({
        id,
        workspace_id: e.workspaceId,
        event_code: e.eventCode,
        actor_user_id: e.actorUserId ?? null,
        staff_user_id: e.staffUserId ?? null,
        params: e.params ?? {},
        created_at: pyIso(this.d.clock()),
      });
    } catch (err) {
      this.d.logger.warn({ err, event: e.eventCode }, "support_access_event write failed");
      id = null;
    }
    if (e.notify ?? true) {
      try {
        await this.notice(
          e.workspaceId,
          e.eventCode,
          e.actorUserId ?? null,
          e.staffUserId ?? null,
          e.params ?? {},
        );
      } catch (err) {
        this.d.logger.warn({ err, event: e.eventCode }, "support access notice failed");
      }
    }
    return id;
  }

  private async displayName(appUserId: string | null): Promise<string> {
    if (!appUserId) return "";
    try {
      return (await this.d.billingStore.appUser(appUserId))?.display_name || "";
    } catch {
      return "";
    }
  }

  private async mail(
    to: readonly string[],
    kind: Parameters<typeof supportEmail>[0],
    data: Record<string, string>,
  ) {
    for (const addr of to) {
      try {
        await this.d.mailer.send({ to: addr, ...supportEmail(kind, data), tags: [kind] });
      } catch (err) {
        this.d.logger.warn({ err, kind }, "support access email failed");
      }
    }
  }

  /** The notification and email for one lifecycle event (old send_support_access_notice). */
  async notice(
    workspaceId: string,
    eventCode: string,
    actorUserId: string | null,
    staffUserId: string | null,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (eventCode === EVENTS.toggleEnabled || eventCode === EVENTS.toggleDisabled) return;
    const ws = await this.d.billingStore.workspace(workspaceId);
    if (!ws) return;
    const now = this.d.clock();
    const wsName = ws.name || "your workspace";
    const orgId = ws.org_id;
    const settingsUrl = this.url(`/w/${workspaceId}/settings/general`);
    const n = this.d.notifier;
    const store = this.d.billingStore;
    const refs = { refOrgId: orgId, refWorkspaceId: workspaceId };

    if (eventCode === EVENTS.requestCreated) {
      const staffName = (await this.displayName(staffUserId)) || "dembrane staff";
      const note = String(params.message ?? "").trim();
      const admins = await workspaceAdmins(store, workspaceId);
      const title = `dembrane staff requested access to ${wsName}`;
      let message = `${staffName} asked to join this workspace for support.`;
      if (note) message = `${message} Note: ${note}`;
      await n.emitToAudience(
        admins,
        {
          eventCode: "SUPPORT_ACCESS_REQUESTED",
          title,
          message: `${message} Approve or deny in workspace settings.`,
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          actorUserId: staffUserId,
          ...refs,
          params: { request_id: params.request_id ?? null },
        },
        now,
      );
      await this.mail(await emailsOf(store, admins), "support_access_request", {
        subject: title,
        workspace_name: wsName,
        staff_name: staffName,
        note,
        settings_url: settingsUrl,
      });
      return;
    }
    if (eventCode === EVENTS.staffJoined) {
      const staffName = (await this.displayName(staffUserId)) || "dembrane staff";
      const admins = await workspaceAdmins(store, workspaceId);
      const title = `dembrane staff joined ${wsName} for support`;
      await n.emitToAudience(
        admins,
        {
          eventCode: "SUPPORT_STAFF_JOINED",
          title,
          message: "Access ends automatically after 24 hours.",
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          actorUserId: staffUserId,
          ...refs,
        },
        now,
      );
      await this.mail(await emailsOf(store, admins), "support_access_joined", {
        subject: title,
        workspace_name: wsName,
        staff_name: staffName,
        settings_url: settingsUrl,
      });
      return;
    }
    if (eventCode === EVENTS.staffExtended) {
      await n.emitToAudience(
        await workspaceAdmins(store, workspaceId),
        {
          eventCode: "SUPPORT_STAFF_EXTENDED",
          title: `dembrane staff extended their support session in ${wsName}`,
          message: "The session ends 24 hours from now.",
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          actorUserId: staffUserId,
          ...refs,
        },
        now,
      );
      return;
    }
    if (eventCode === EVENTS.staffLeft || eventCode === EVENTS.staffAutoRevoked) {
      await n.emitToAudience(
        await workspaceAdmins(store, workspaceId),
        {
          eventCode: "SUPPORT_STAFF_LEFT",
          title: `A dembrane staff member left ${wsName}`,
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          actorUserId: staffUserId,
          ...refs,
        },
        now,
      );
      return;
    }
    if (eventCode === EVENTS.toggleAutoDisabled || eventCode === EVENTS.reminderSent) {
      const ended = eventCode === EVENTS.toggleAutoDisabled;
      const admins = await workspaceAdmins(store, workspaceId);
      const title = ended
        ? `Support access to ${wsName} turned off`
        : `Support access to ${wsName} is still on`;
      await n.emitToAudience(
        admins,
        {
          eventCode: ended ? "SUPPORT_ACCESS_ENDED" : "SUPPORT_ACCESS_REMINDER",
          title,
          message: ended
            ? "The support session ended and staff access was turned off. Turn it back on in workspace settings if you need more help."
            : "No staff joined in the last 7 days. Turn it off in workspace settings if you no longer need help.",
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          ...refs,
        },
        now,
      );
      await this.mail(
        await emailsOf(store, admins),
        ended ? "support_access_ended" : "support_access_reminder",
        { subject: title, workspace_name: wsName, settings_url: settingsUrl },
      );
      return;
    }
    if (eventCode === EVENTS.requestApproved || eventCode === EVENTS.requestDenied) {
      if (!staffUserId) return;
      const decision = eventCode === EVENTS.requestApproved ? "approved" : "denied";
      const title = `Access request for ${wsName} ${decision}`;
      await n.emit(
        staffUserId,
        {
          eventCode:
            decision === "approved" ? "SUPPORT_REQUEST_APPROVED" : "SUPPORT_REQUEST_DENIED",
          title,
          message: decision === "approved" ? "You have admin access for 24 hours." : null,
          actorUserId,
          ...refs,
          params: { request_id: params.request_id ?? null },
        },
        now,
      );
      await this.mail(await emailsOf(store, [staffUserId]), "support_access_request_resolved", {
        subject: title,
        workspace_name: wsName,
        decision,
        workspace_url: this.url(`/w/${workspaceId}/home`),
      });
      return;
    }
    if (eventCode === EVENTS.requestExpired) {
      if (!staffUserId) return;
      await n.emit(
        staffUserId,
        {
          eventCode: "SUPPORT_REQUEST_EXPIRED",
          title: `Access request for ${wsName} expired`,
          ...refs,
          params: { request_id: params.request_id ?? null },
        },
        now,
      );
      return;
    }
    if (eventCode === EVENTS.requestCancelled) {
      if (params.reason !== "toggle_enabled" || !staffUserId) return;
      await n.emit(
        staffUserId,
        {
          eventCode: "SUPPORT_REQUEST_SUPERSEDED",
          title: `Support access for ${wsName} is now on`,
          message: "You can join directly from the admin console.",
          ...refs,
          params: { request_id: params.request_id ?? null },
        },
        now,
      );
    }
  }

  /**
   * When the last live support session ends, turns the standing toggle off, stops its
   * reminders and records it. True when this call flipped it.
   */
  async maybeAutoDisable(workspaceId: string): Promise<boolean> {
    const now = this.d.clock();
    const ws = await this.s.workspace(workspaceId);
    if (!ws?.allow_support_access) return false;
    const rows = await this.s.supportRows(workspaceId);
    if (rows.some((r) => !membershipExpired(r.expires_at, now))) return false;
    await this.s.updateWorkspace(workspaceId, { allow_support_access: false }, now);
    await cancelPendingTasks(
      this.d.db,
      SUPPORT_TASKS.supportToggleReminder,
      { workspace_id: workspaceId },
      now,
    );
    await this.record({ workspaceId, eventCode: EVENTS.toggleAutoDisabled });
    return true;
  }

  /** The revoke timer: soft-deletes the support row if it is still a live support row. */
  async revoke(workspaceId: string, membershipId: string): Promise<boolean> {
    const now = this.d.clock();
    const m = await this.s.membership(membershipId);
    // A soft-deleted id can come back as a genuine direct member; never strip that.
    if (!m || m.deleted_at || m.source !== "staff_support") return false;
    await this.s.updateMembership(membershipId, { deleted_at: pyIso(now) }, now);
    await this.record({
      workspaceId,
      eventCode: EVENTS.staffAutoRevoked,
      staffUserId: m.user_id,
      params: { membership_id: membershipId },
      notify: false,
    });
    if (!(await this.maybeAutoDisable(workspaceId)))
      await this.notice(workspaceId, EVENTS.staffAutoRevoked, null, m.user_id, {});
    return true;
  }

  /** The request timer: expires a still-pending request; a decision that raced it wins. */
  async expireRequest(requestId: string): Promise<boolean> {
    const req = await this.s.request(requestId);
    if (req?.status !== "pending") return false;
    await this.s.updateRequest(requestId, {
      status: "expired",
      resolved_at: pyIso(this.d.clock()),
    });
    await this.record({
      workspaceId: req.workspace_id,
      eventCode: EVENTS.requestExpired,
      staffUserId: req.requested_by,
      params: { request_id: requestId },
    });
    return true;
  }

  /** The weekly reminder while the toggle stays on; returns the next fire time or null to stop. */
  async reminderTick(workspaceId: string): Promise<Date | null> {
    const now = this.d.clock();
    const ws = await this.s.workspace(workspaceId);
    if (!ws || ws.deleted_at || !ws.allow_support_access) return null;
    const rows = await this.s.supportRows(workspaceId);
    if (!rows.some((r) => !membershipExpired(r.expires_at, now)))
      await this.record({ workspaceId, eventCode: EVENTS.reminderSent });
    return new Date(now.getTime() + REMINDER_INTERVAL_MS);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
