import type { DirectRow, OrgRow } from "./members";
import type {
  AccountPatch,
  AccountRow,
  AppUserRow,
  BillingStore,
  NotificationRow,
  WorkspaceRow,
} from "./store";

type Membership = DirectRow & { id: string; workspace_id: string; deleted_at?: string | null };
type OrgMembership = OrgRow & { id: string; org_id: string; deleted_at?: string | null };
type Invite = {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at?: string | null;
  deleted_at?: string | null;
};

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** A billing account with the column defaults Postgres would fill in. */
export function accountRow(p: Partial<AccountRow> & { id: string }): AccountRow {
  return {
    billing_period: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    deleted_at: null,
    downgraded_at: null,
    downgraded_from_tier: null,
    label: null,
    mollie_customer_id: null,
    mollie_subscription_id: null,
    org_id: null,
    payment_mode: "none",
    percent_discount: null,
    pre_warning_sent: false,
    provisioned_seats: null,
    status: "none",
    tier: "free",
    tier_expires_at: null,
    type_discount: null,
    updated_at: null,
    workspace_id: null,
    account_manager_id: null,
    billing_address_line1: null,
    billing_address_line2: null,
    billing_city: null,
    billing_country: null,
    billing_legal_name: null,
    billing_postal_code: null,
    billing_vat_id: null,
    billing_vat_region: null,
    payment_failed_notified: false,
    reconcile_failed_at: null,
    ...p,
  };
}

/** In-memory twin of billingStorage: the same contract, used by the service and job tests. */
export class MemoryBillingStore implements BillingStore {
  accounts = new Map<string, AccountRow>();
  workspaces = new Map<string, WorkspaceRow>();
  memberships: Membership[] = [];
  orgMembers: OrgMembership[] = [];
  invites: Invite[] = [];
  users = new Map<string, AppUserRow>();
  orgs = new Map<string, string>();
  projects = new Map<string, string>();
  notifications: NotificationRow[] = [];
  logoCleared: string[] = [];
  overCapCleared: string[] = [];

  async account(id: string) {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }
  async updateAccount(id: string, patch: AccountPatch, now: Date) {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, ...patch, updated_at: now.toISOString() });
  }
  async accountWorkspaceIds(accountId: string) {
    return [...this.workspaces.values()]
      .filter((w) => w.billing_account_id === accountId && !w.deleted_at)
      .sort(byId)
      .map((w) => w.id);
  }
  async workspace(id: string) {
    return this.workspaces.get(id) ?? null;
  }
  async directMemberships(workspaceId: string) {
    return this.memberships
      .filter(
        (m) => m.workspace_id === workspaceId && !m.deleted_at && m.source !== "staff_support",
      )
      .sort(byId);
  }
  async orgMemberships(orgId: string, roles: readonly string[]) {
    return this.orgMembers
      .filter((m) => m.org_id === orgId && !m.deleted_at && m.role && roles.includes(m.role))
      .sort(byId);
  }
  async pendingInvites(workspaceId: string, now: Date) {
    return this.invites
      .filter(
        (i) =>
          i.workspace_id === workspaceId &&
          !i.accepted_at &&
          !i.deleted_at &&
          new Date(i.expires_at) > now,
      )
      .sort(byId)
      .map((i) => ({ email: i.email, role: i.role }));
  }
  async appUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async appUsers(ids: readonly string[]) {
    return [...this.users.values()].filter((u) => ids.includes(u.id)).sort(byId);
  }
  async orgAccountId(orgId: string) {
    const live = [...this.accounts.values()]
      .filter((a) => a.org_id === orgId && !a.deleted_at)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || byId(a, b));
    return live[0]?.id ?? null;
  }
  async hasOrgRole(orgId: string, appUserId: string, roles: readonly string[]) {
    return this.orgMembers.some(
      (m) =>
        m.org_id === orgId &&
        m.user_id === appUserId &&
        !m.deleted_at &&
        m.role !== null &&
        roles.includes(m.role),
    );
  }
  async orgName(id: string) {
    return this.orgs.get(id) ?? null;
  }
  async projectName(id: string) {
    return this.projects.get(id) ?? null;
  }
  async insertNotification(row: NotificationRow) {
    this.notifications.push(row);
  }
  async clearWorkspaceLogo(workspaceId: string) {
    this.logoCleared.push(workspaceId);
  }
  async clearOverCapStamps(workspaceId: string) {
    this.overCapCleared.push(workspaceId);
    return 0;
  }
  async claimPrewarning(accountId: string, now: Date) {
    const a = this.accounts.get(accountId);
    if (!a || a.pre_warning_sent) return false;
    this.accounts.set(accountId, { ...a, pre_warning_sent: true, updated_at: now.toISOString() });
    return true;
  }
  async pendingAccountsWithCustomer() {
    return [...this.accounts.values()]
      .filter((a) => a.status === "pending" && a.mollie_customer_id && !a.deleted_at)
      .sort(byId)
      .map((a) => a.id);
  }
  async activeAccountsWithSubscription() {
    return [...this.accounts.values()]
      .filter((a) => a.status === "active" && a.mollie_subscription_id && !a.deleted_at)
      .sort(byId)
      .map((a) => a.id);
  }
  async expiredTierAccounts(now: Date) {
    return [...this.accounts.values()]
      .filter(
        (a) =>
          a.tier_expires_at !== null &&
          new Date(a.tier_expires_at) < now &&
          a.tier !== "free" &&
          a.payment_mode !== "offline" &&
          !a.deleted_at,
      )
      .sort(byId)
      .map((a) => ({ id: a.id, tier: a.tier, workspace_id: a.workspace_id }));
  }
  async prewarnAccounts(from: Date, until: Date) {
    return [...this.accounts.values()]
      .filter((a) => {
        if (a.tier_expires_at === null) return false;
        const t = new Date(a.tier_expires_at);
        return (
          t >= from &&
          t <= until &&
          a.tier !== "free" &&
          !a.pre_warning_sent &&
          a.payment_mode !== "offline" &&
          !a.deleted_at
        );
      })
      .sort(byId)
      .map((a) => ({
        id: a.id,
        tier: a.tier,
        tier_expires_at: a.tier_expires_at,
        workspace_id: a.workspace_id,
      }));
  }
}
