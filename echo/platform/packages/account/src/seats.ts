import { UnavailableError } from "@echo/core";
import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import type { Logger } from "@echo/observability";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { Jobs } from "./deps";
import { reconcileAccountSeats } from "./jobs";

const { billing_account, workspace, workspace_membership, workspace_invite, app_user } = schema;

/**
 * The seat side of billing that membership changes touch. Seats are pooled per billing
 * account: a user in several of its workspaces is one seat. Observers never hold a seat,
 * staff support rows never count, and derived org access does not occupy a seat.
 *
 * The seat hard cap is gone (CTO decision 12): no tier blocks at a seat count today, so
 * the old cap check, which never fired, is not ported. What remains is the reactivation
 * gate on invites and the reconcile after a seat is taken.
 */
const SEAT_ROLES = ["owner", "admin", "member", "billing", "external"];

export type BillingAccount = typeof billing_account.$inferSelect;

export async function accountForWorkspace(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ account: billing_account })
    .from(workspace)
    .innerJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return row?.account ?? null;
}

/** Paid seats may only be added on an active plan; canceled and past-due accounts reactivate first. */
export function accountBlocksSeatAdd(account: BillingAccount | null): "reactivate_required" | null {
  if (!account || account.status === "active") return null;
  return account.status === "canceled" || account.status === "past_due"
    ? "reactivate_required"
    : null;
}

async function accountWorkspaceIds(db: Db, accountId: string) {
  const rows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(eq(workspace.billing_account_id, accountId), isNull(workspace.deleted_at)));
  return rows.map((r) => r.id);
}

async function seatHolders(db: Db, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  return db
    .selectDistinct({ userId: workspace_membership.user_id, email: app_user.email })
    .from(workspace_membership)
    .leftJoin(app_user, eq(app_user.id, workspace_membership.user_id))
    .where(
      and(
        inArray(workspace_membership.workspace_id, [...workspaceIds]),
        isNull(workspace_membership.deleted_at),
        eq(workspace_membership.source, "direct"),
        inArray(workspace_membership.role, SEAT_ROLES),
      ),
    );
}

export async function countAccountSeats(db: Db, accountId: string): Promise<number> {
  const holders = await seatHolders(db, await accountWorkspaceIds(db, accountId));
  return new Set(holders.map((h) => h.userId)).size;
}

/**
 * Recipients who would add a seat: not already a seat holder anywhere on the account and
 * not already invited to a paid role (founder rule A1: inviting an existing member is free).
 */
export async function countNetNewSeats(
  db: Db,
  accountId: string,
  recipients: readonly string[],
  now: Date,
): Promise<number> {
  const cleaned = new Set(recipients.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!cleaned.size) return 0;
  const wsIds = await accountWorkspaceIds(db, accountId);
  const already = new Set<string>();
  for (const h of await seatHolders(db, wsIds))
    if (h.email) already.add(h.email.trim().toLowerCase());
  if (wsIds.length) {
    const pending = await db
      .select({ email: workspace_invite.email })
      .from(workspace_invite)
      .where(
        and(
          inArray(workspace_invite.workspace_id, wsIds),
          isNull(workspace_invite.accepted_at),
          isNull(workspace_invite.deleted_at),
          gt(workspace_invite.expires_at, now.toISOString()),
          ne(workspace_invite.role, "observer"),
        ),
      );
    for (const p of pending) already.add(p.email.trim().toLowerCase());
  }
  return [...cleaned].filter((e) => !already.has(e)).length;
}

/**
 * The invite dialog's cost preview. Accounts without a running paid subscription charge
 * nothing and answer here; pricing a live Mollie subscription needs its next payment date
 * from Mollie, which the billing namespace owns, so that branch answers 503 until billing
 * is merged in.
 */
export async function estimateSeatAddition(
  db: Db,
  accountId: string,
  opts: { added: number; recipients: readonly string[] | null },
  now: Date,
) {
  const [account] = await db
    .select()
    .from(billing_account)
    .where(eq(billing_account.id, accountId))
    .limit(1);
  const added =
    opts.recipients !== null
      ? await countNetNewSeats(db, accountId, opts.recipients, now)
      : Math.max(0, opts.added);
  const result = {
    active: false,
    added_seats: added,
    billing_period: account?.billing_period || "annual",
    currency: "EUR",
    prorated_now_eur: 0.0,
    recurring_delta_eur: 0.0,
    covered_by_existing_seats: 0,
  };
  if (account?.status !== "active") return result;
  if (!account.tier || account.tier === "free" || !account.mollie_subscription_id) return result;
  if (added < 1) return { ...result, active: true };
  throw new UnavailableError("Seat pricing is temporarily unavailable");
}

/** After a seat is taken: queue a reconcile when the account bills per seat. */
export async function requestSeatReconcile(
  db: Db,
  jobs: Jobs,
  workspaceId: string,
  logger?: Logger,
): Promise<void> {
  try {
    const account = await accountForWorkspace(db, workspaceId);
    if (account?.status !== "active" || !account.tier || account.tier === "free") return;
    await jobs.enqueue(
      reconcileAccountSeats,
      { accountId: account.id },
      { singletonKey: account.id },
    );
  } catch (err) {
    // Billing never blocks collaboration; the periodic reconcile is the backstop.
    logger?.error({ err, workspaceId }, "seat reconcile could not be queued");
  }
}

/**
 * Managed accounts (payment_mode offline) record the live seat count for staff to invoice;
 * nothing is charged. Accounts on a Mollie subscription are re-priced and prorated by the
 * billing namespace's handler for this job, which replaces this one when it lands.
 */
export async function reconcileSeats(db: Db, accountId: string, logger: Logger): Promise<void> {
  const [account] = await db
    .select()
    .from(billing_account)
    .where(eq(billing_account.id, accountId))
    .limit(1);
  if (account?.status !== "active" || !account.tier || account.tier === "free") return;
  if (account.payment_mode === "offline") {
    const current = Math.max(await countAccountSeats(db, accountId), 1);
    await db
      .update(billing_account)
      .set({ provisioned_seats: current, updated_at: new Date().toISOString() })
      .where(eq(billing_account.id, accountId));
    return;
  }
  if (account.mollie_subscription_id) {
    logger.warn(
      { signal: "billing.reconcile_pending", accountId },
      "seat reconcile for a Mollie subscription waits for the billing namespace",
    );
  }
}
