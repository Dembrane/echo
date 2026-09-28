import { newId } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import { derivingOrgRoles, effectiveMembersFromRows } from "./members";
import type { BillingStore } from "./store";

/**
 * In-app notifications as the old notifications.emit wrote them: one row per recipient,
 * severity from the event, the "Org > Workspace > Project" breadcrumb frozen at emit
 * time. Best effort: a failed notification never fails the action that caused it.
 */
const SEVERITY: Readonly<Record<string, string>> = {
  WORKSPACE_REMOVED: "destructive",
  ORGANISATION_REMOVED: "destructive",
  PROJECT_NOW_PRIVATE: "destructive",
  PROJECT_SHARE_REVOKED: "destructive",
  TIER_DOWNGRADED: "destructive",
  INVITE_CANCELLED: "destructive",
  REPORT_FAILED: "destructive",
  MEMBERSHIP_REQUESTED: "action_required",
  INVITE_BLOCKED_AT_CAP: "action_required",
  INVITE_PENDING_AT_CAP: "action_required",
  WORKSPACE_REQUEST_SUBMITTED: "action_required",
  TIER_EXPIRED: "destructive",
  TIER_EXPIRING_SOON: "action_required",
  TRAINING_REQUESTED: "action_required",
  PARTNER_HANDOFF_PENDING: "action_required",
  ONBOARDING_FOLLOWUP: "action_required",
  PAYMENT_FAILED: "action_required",
  SUPPORT_ACCESS_REQUESTED: "action_required",
  SUPPORT_ACCESS_REMINDER: "action_required",
};

export function severityFor(eventCode: string): string {
  return SEVERITY[eventCode] ?? "info";
}

export interface Emit {
  readonly eventCode: string;
  readonly title: string;
  readonly message?: string | null;
  readonly action?: string;
  readonly actorUserId?: string | null;
  readonly refOrgId?: string | null;
  readonly refWorkspaceId?: string | null;
  readonly refProjectId?: string | null;
  readonly params?: Record<string, unknown> | null;
}

export class Notifier {
  constructor(
    private readonly store: BillingStore,
    private readonly logger: Logger,
  ) {}

  private async scope(e: Emit): Promise<string | null> {
    const parts: string[] = [];
    try {
      if (e.refOrgId) {
        const n = await this.store.orgName(e.refOrgId);
        if (n) parts.push(n);
      }
      if (e.refWorkspaceId) {
        const n = (await this.store.workspace(e.refWorkspaceId))?.name;
        if (n) parts.push(n);
      }
      if (e.refProjectId) {
        const n = await this.store.projectName(e.refProjectId);
        if (n) parts.push(n);
      }
    } catch {
      // The breadcrumb is cosmetic.
    }
    return parts.length ? parts.join(" › ") : null;
  }

  async emit(audienceUserId: string, e: Emit, now: Date): Promise<string | null> {
    try {
      const id = newId();
      await this.store.insertNotification(
        {
          id,
          audience_user_id: audienceUserId,
          actor_user_id: e.actorUserId ?? null,
          event_code: e.eventCode,
          severity: severityFor(e.eventCode),
          action: e.action ?? "NONE",
          title: e.title,
          message: e.message ?? null,
          scope: await this.scope(e),
          params: e.params ?? null,
          ref_org_id: e.refOrgId ?? null,
          ref_workspace_id: e.refWorkspaceId ?? null,
          ref_project_id: e.refProjectId ?? null,
          expires_at: null,
        },
        now,
      );
      return id;
    } catch (err) {
      this.logger.warn({ err, event: e.eventCode }, "emit notification failed");
      return null;
    }
  }

  /** The same notification to each recipient, skipping the actor. */
  async emitToAudience(audience: readonly string[], e: Emit, now: Date): Promise<string[]> {
    const created: string[] = [];
    for (const uid of audience) {
      if (e.actorUserId && uid === e.actorUserId) continue;
      const id = await this.emit(uid, e, now);
      if (id) created.push(id);
    }
    return created;
  }
}

/** Effective members of a live workspace, as the old get_effective_members returned them. */
export async function effectiveMembers(store: BillingStore, workspaceId: string) {
  const ws = await store.workspace(workspaceId);
  if (!ws || ws.deleted_at) return [];
  const direct = await store.directMemberships(workspaceId);
  if (!ws.org_id) return effectiveMembersFromRows(ws, direct, []);
  const org = await store.orgMemberships(ws.org_id, derivingOrgRoles(ws));
  return effectiveMembersFromRows(ws, direct, org);
}

export async function workspaceAdmins(store: BillingStore, workspaceId: string) {
  return (await effectiveMembers(store, workspaceId))
    .filter((m) => m.role === "admin" || m.role === "owner")
    .map((m) => m.user_id);
}

export async function workspaceAdminsAndBilling(store: BillingStore, workspaceId: string) {
  return (await effectiveMembers(store, workspaceId))
    .filter((m) => m.role === "admin" || m.role === "owner" || m.role === "billing")
    .map((m) => m.user_id);
}

export async function orgAdmins(store: BillingStore, orgId: string) {
  return (await store.orgMemberships(orgId, ["admin", "owner"]))
    .map((r) => r.user_id)
    .filter((u): u is string => Boolean(u));
}

/** Owners and admins who hear about an account's billing: the org's, or the workspace's. */
export async function billingAccountAdmins(
  store: BillingStore,
  account: { org_id: string | null; workspace_id: string | null },
) {
  if (account.org_id) return orgAdmins(store, account.org_id);
  if (account.workspace_id) return workspaceAdmins(store, account.workspace_id);
  return [];
}

/** Distinct trimmed addresses of the given users, sorted, as the old email fan-out built them. */
/**
 * Each recipient's address with the language their dashboard is set to (null: English),
 * one entry per address, sorted by address.
 */
export async function recipientsOf(store: BillingStore, userIds: readonly string[]) {
  if (!userIds.length) return [];
  const byEmail = new Map<string, string | null>();
  for (const r of await store.appUsers(userIds)) {
    const email = (r.email ?? "").trim();
    if (email && !byEmail.has(email)) byEmail.set(email, r.language ?? null);
  }
  return [...byEmail]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([email, locale]) => ({ email, locale }));
}

export async function emailsOf(store: BillingStore, userIds: readonly string[]) {
  if (!userIds.length) return [];
  const rows = await store.appUsers(userIds);
  return [...new Set(rows.map((r) => (r.email ?? "").trim()).filter(Boolean))].sort();
}
