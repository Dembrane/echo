import type { AccountRow } from "./store";

/**
 * Pure account rules other namespaces ask billing (invites, workspace creation, project
 * moves, tier changes). Ported from billing_service.py and billing_account.py so every
 * caller reads one implementation.
 */

/** Why a seat may not be added: only an active plan takes new seats; canceled or past due must reactivate. */
export function accountBlocksSeatAdd(account: Pick<AccountRow, "status"> | null): string | null {
  if (!account) return null;
  if (account.status === "active") return null;
  if (account.status === "canceled" || account.status === "past_due") return "reactivate_required";
  return null;
}

/** Why an account cannot take a new workspace; past due still can (a failed charge never locks anyone out). */
export function billingAccountBlocksNewWorkspace(
  account: Pick<AccountRow, "deleted_at" | "status"> | null,
): string | null {
  if (!account || account.deleted_at) return "organisation has no valid billing account";
  if (account.status === "canceled")
    return "organisation billing is canceled; reactivate it to add workspaces";
  return null;
}

/** A running Mollie subscription; tier changes that would orphan it are refused by callers. */
export function hasLiveMollieSubscription(
  account: Pick<AccountRow, "payment_mode" | "mollie_subscription_id"> | null,
): boolean {
  return (
    Boolean(account) &&
    account?.payment_mode === "mollie" &&
    Boolean(account.mollie_subscription_id)
  );
}

/**
 * The data-ownership context of a workspace's account: the org for org-scoped accounts,
 * the account itself for a workspace billed separately. Projects move only within one.
 */
export function billingContextKey(
  account: Pick<AccountRow, "id" | "org_id" | "workspace_id"> | null,
): string | null {
  if (!account) return null;
  if (account.org_id) return `org:${account.org_id}`;
  return `workspace:${account.id || account.workspace_id || ""}`;
}

export function sameBillingContext(
  a: Pick<AccountRow, "id" | "org_id" | "workspace_id"> | null,
  b: Pick<AccountRow, "id" | "org_id" | "workspace_id"> | null,
): boolean {
  const ka = billingContextKey(a);
  return ka !== null && ka === billingContextKey(b);
}
