import { reconcileAccountSeats } from "@dembrane/billing";
import { newId } from "@dembrane/core";
import type { schema } from "@dembrane/db";
import { type Conn, iso } from "./db";
import type { JobSink } from "./jobs";
import {
  type BillingAccountRow,
  billingAccountById,
  insertBillingAccount,
  orgBillingAccountId,
  updateBillingAccount,
  type WorkspaceRowFull,
} from "./storage/tenancy";

/**
 * The commercial fields a workspace reads through its billing account. There is no tier on
 * the workspace: an org-scoped account pools many workspaces, a workspace-scoped one funds
 * exactly one (an external client's).
 */
export interface Commercial {
  readonly tier: string | null;
  readonly tier_expires_at: string | null;
  readonly downgraded_at: string | null;
  readonly downgraded_from_tier: string | null;
  readonly percent_discount: number | null;
  readonly type_discount: string | null;
  readonly billing_period: string | null;
  readonly status: string | null;
  /** The account belongs to the org (pooled) rather than to this one workspace. */
  readonly org_scoped: boolean;
}

export function commercial(account: BillingAccountRow | null): Commercial | null {
  if (!account) return null;
  return {
    tier: account.tier,
    tier_expires_at: account.tier_expires_at,
    downgraded_at: account.downgraded_at,
    downgraded_from_tier: account.downgraded_from_tier,
    percent_discount: account.percent_discount,
    type_discount: account.type_discount,
    billing_period: account.billing_period,
    status: account.status,
    org_scoped: Boolean(account.org_id),
  };
}

/**
 * External-client workspaces carry their own billing and compliance context. The label is
 * usage_context; rows from before it existed are recognised by a named data owner or a
 * completed handoff.
 */
export function isExternalClient(
  ws: Pick<WorkspaceRowFull, "usage_context" | "data_owner_email" | "billed_to_team_id" | "org_id">,
): boolean {
  const uc = (ws.usage_context ?? "").trim().toLowerCase();
  if (uc) return uc === "external";
  if ((ws.data_owner_email ?? "").trim()) return true;
  return Boolean(ws.billed_to_team_id) && ws.billed_to_team_id !== ws.org_id;
}

/** Why an account cannot take another workspace, or null when it can. */
export function blocksNewWorkspace(account: BillingAccountRow | null): string | null {
  if (!account || account.deleted_at) return "organisation has no valid billing account";
  if (account.status === "canceled")
    return "organisation billing is canceled; reactivate it to add workspaces";
  return null;
}

export function hasLiveMollieSubscription(account: BillingAccountRow | null): boolean {
  return account?.payment_mode === "mollie" && Boolean(account.mollie_subscription_id);
}

/** Paid or subscribed billing that must not be moved without a person handling it. */
export function hasActiveBilling(account: BillingAccountRow | null): boolean {
  if (!account) return false;
  if ((account.tier || "free") !== "free") return true;
  if (account.mollie_subscription_id) return true;
  return !["", "none"].includes(account.payment_mode || "none");
}

export async function createWorkspaceAccount(
  db: Conn,
  now: Date,
  opts: { createdBy: string; label: string },
): Promise<string> {
  const id = newId();
  const at = iso(now);
  await insertBillingAccount(db, {
    id,
    tier: "free",
    payment_mode: "none",
    created_by: opts.createdBy,
    label: opts.label,
    created_at: at,
    updated_at: at,
  });
  return id;
}

/** The org's pooled account, created free on first need. */
export async function orgAccountForNewWorkspace(
  db: Conn,
  now: Date,
  orgId: string,
  createdBy: string,
): Promise<string> {
  const existing = await orgBillingAccountId(db, orgId);
  if (existing) return existing;
  const id = newId();
  const at = iso(now);
  await insertBillingAccount(db, {
    id,
    org_id: orgId,
    tier: "free",
    payment_mode: "none",
    created_by: createdBy,
    label: "Org billing",
    created_at: at,
    updated_at: at,
  });
  return id;
}

export async function updateAccount(
  db: Conn,
  now: Date,
  accountId: string,
  patch: Partial<typeof schema.billing_account.$inferInsert>,
) {
  await updateBillingAccount(db, accountId, { ...patch, updated_at: iso(now) });
}

/**
 * Asks billing to re-price the account for its new seat count, in the transaction that
 * changed the seats, so no seat change goes unbilled. Billing owns the handler.
 */
export async function reconcileSeats(
  jobs: JobSink,
  tx: Conn,
  accountId: string | null | undefined,
) {
  if (accountId) await jobs.enqueue(reconcileAccountSeats, { accountId }, { tx });
}

export async function accountOfWorkspace(
  db: Conn,
  ws: Pick<WorkspaceRowFull, "billing_account_id">,
) {
  return billingAccountById(db, ws.billing_account_id);
}
