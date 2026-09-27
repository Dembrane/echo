import type { schema } from "@echo/db";
import type { DirectRow, OrgRow, WorkspaceForMembers } from "./members";

export type AccountRow = typeof schema.billing_account.$inferSelect;
export type AccountPatch = Partial<Omit<AccountRow, "id" | "created_at" | "updated_at">>;

export interface WorkspaceRow extends WorkspaceForMembers {
  readonly id: string;
  readonly name: string;
  readonly deleted_at: string | null;
  readonly billing_account_id: string | null;
}

export interface AppUserRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
}

export interface NotificationRow {
  readonly id: string;
  readonly audience_user_id: string;
  readonly actor_user_id: string | null;
  readonly event_code: string;
  readonly severity: string;
  readonly action: string;
  readonly title: string;
  readonly message: string | null;
  readonly scope: string | null;
  readonly params: unknown;
  readonly ref_org_id: string | null;
  readonly ref_workspace_id: string | null;
  readonly ref_project_id: string | null;
  readonly expires_at: string | null;
}

/**
 * The rows billing reads and writes. The Drizzle implementation mirrors the Directus
 * queries of the old service (default order by primary key, soft-deleted rows filtered
 * in the query, `updated_at` stamped on every update); the in-memory twin backs the
 * service tests.
 */
export interface BillingStore {
  account(id: string): Promise<AccountRow | null>;
  /** Writes the patch and stamps updated_at, as Directus did for this collection. */
  updateAccount(id: string, patch: AccountPatch, now: Date): Promise<void>;
  /** Live workspaces billed through the account, in id order. */
  accountWorkspaceIds(accountId: string): Promise<string[]>;
  workspace(id: string): Promise<WorkspaceRow | null>;
  /** Active direct rows of a workspace, staff support excluded, in id order. */
  directMemberships(workspaceId: string): Promise<DirectRow[]>;
  /** Active org rows in the given roles, in id order. */
  orgMemberships(orgId: string, roles: readonly string[]): Promise<OrgRow[]>;
  /** Pending (unaccepted, unexpired, not deleted) invites of a workspace. */
  pendingInvites(workspaceId: string, now: Date): Promise<{ email: string; role: string }[]>;
  appUser(id: string): Promise<AppUserRow | null>;
  appUsers(ids: readonly string[]): Promise<AppUserRow[]>;
  /** The oldest live org-scoped account of an org. */
  orgAccountId(orgId: string): Promise<string | null>;
  hasOrgRole(orgId: string, appUserId: string, roles: readonly string[]): Promise<boolean>;
  orgName(id: string): Promise<string | null>;
  projectName(id: string): Promise<string | null>;
  insertNotification(row: NotificationRow, now: Date): Promise<void>;
  /** Downgrade revert: the custom logo goes back to dembrane's. */
  clearWorkspaceLogo(workspaceId: string, now: Date): Promise<void>;
  /** Unlocks every over-cap conversation of the workspace's projects; returns how many. */
  clearOverCapStamps(workspaceId: string, now: Date): Promise<number>;
  /** Sets pre_warning_sent only if it was still false; true when this caller claimed it. */
  claimPrewarning(accountId: string, now: Date): Promise<boolean>;
  /** Account ids for the reconcile schedules. */
  pendingAccountsWithCustomer(): Promise<string[]>;
  activeAccountsWithSubscription(): Promise<string[]>;
  /** Accounts whose paid tier has lapsed; managed accounts never auto-expire. */
  expiredTierAccounts(now: Date): Promise<Pick<AccountRow, "id" | "tier" | "workspace_id">[]>;
  /** Accounts expiring within the window that have not been warned yet. */
  prewarnAccounts(
    from: Date,
    until: Date,
  ): Promise<Pick<AccountRow, "id" | "tier" | "tier_expires_at" | "workspace_id">[]>;
}
