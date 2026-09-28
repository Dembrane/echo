import { directusTime, parseTime, pyRound } from "@dembrane/legacy-shape";
import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { paymentFailedEmail } from "./emails";
import { SEAT_ROLES } from "./members";
import {
  amountOf,
  checkoutUrl,
  type Mollie,
  MollieError,
  type MollieObject,
  meta,
  str,
} from "./mollie";
import { applyDiscount, money2 } from "./money";
import { billingAccountAdmins, type Notifier, recipientsOf } from "./notify";
import type { AccountPatch, AccountRow, BillingStore } from "./store";
import {
  BillingError,
  computeMonthlyBillingPrice,
  getCapacity,
  managedNextInvoiceAmount,
  PAYABLE_TIERS,
  PURCHASABLE_TIERS,
  perIntervalAmount,
  periodEndIso,
  planDescription,
  pyIso,
  subscriptionStartDate,
} from "./tiers";

/** Product analytics (PostHog). Events are fire-and-forget. */
export type Capture = (
  distinctId: string,
  event: string,
  props: Record<string, unknown>,
) => Promise<void>;

/**
 * Remembers an amount Mollie refused for a subscription re-price, so the schedule does
 * not resend the same refused amount every run. Process-local with a 7-day expiry: a
 * restart costs at most one repeated call.
 */
export class RepriceMemo {
  private readonly rejected = new Map<string, { amount: number; until: number }>();
  get(accountId: string, now: Date): number | null {
    const hit = this.rejected.get(accountId);
    if (!hit || hit.until <= now.getTime()) return null;
    return hit.amount;
  }
  set(accountId: string, amount: number | null, now: Date): void {
    if (amount === null) this.rejected.delete(accountId);
    else
      this.rejected.set(accountId, {
        amount: pyRound(amount, 2),
        until: now.getTime() + 7 * 86_400_000,
      });
  }
}

export interface BillingConfig {
  readonly webhookUrl: string | null;
  /** Test mode only: every seat reconcile fails, to exercise the fix-your-payment path. */
  readonly forceReconcileFailure: boolean;
  /** Dashboard origin for links in emails. */
  readonly dashboardUrl: string;
}

export interface BillingDeps {
  readonly store: BillingStore;
  readonly mollie: Mollie;
  readonly mailer: Mailer;
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly config: BillingConfig;
  readonly capture: Capture;
  readonly repriceMemo: RepriceMemo;
  /**
   * Runs fn while holding a per-key lock, or returns undefined without running it when
   * another caller holds it. Serialises activation across the webhook, the return sync
   * and the reconcile schedule so only one of them creates the subscription.
   */
  readonly tryLock: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
  readonly clock: () => Date;
}

export { BillingError };

class ReconcileChargeError extends Error {
  override name = "ReconcileChargeError";
}

/** Mollie refused a re-price with a 4xx; `repeated` marks a rerun that skipped the call. */
export class RepriceRejectedError extends MollieError {
  constructor(
    message: string,
    readonly repeated = false,
  ) {
    super(message, 422);
    this.name = "RepriceRejectedError";
  }
}

const FAILED_STATUSES = new Set(["failed", "expired", "canceled"]);
const LEDGER_FETCH = 50;
const LEDGER_MAX_FETCHES = 12;
const PERIOD_DAYS: Record<string, number> = { monthly: 30, annual: 365 };

export const BILLING_DETAIL_FIELDS = [
  "billing_legal_name",
  "billing_vat_id",
  "billing_vat_region",
  "billing_country",
  "billing_address_line1",
  "billing_address_line2",
  "billing_postal_code",
  "billing_city",
] as const;
export type BillingDetailField = (typeof BILLING_DETAIL_FIELDS)[number];

/** Managed ("managed by dembrane") means offline payment: no Mollie auto-debit behaviour at all. */
export function isManaged(account: Pick<AccountRow, "payment_mode"> | null): boolean {
  return Boolean(account) && account?.payment_mode === "offline";
}

export function billingDetailsFromAccount(
  account: AccountRow,
): Record<BillingDetailField, string | null> {
  return Object.fromEntries(BILLING_DETAIL_FIELDS.map((f) => [f, account[f] ?? null])) as Record<
    BillingDetailField,
    string | null
  >;
}

export class BillingService {
  constructor(private readonly d: BillingDeps) {}

  private get store() {
    return this.d.store;
  }
  private get mollie() {
    return this.d.mollie;
  }
  private now() {
    return this.d.clock();
  }
  private update(id: string, patch: AccountPatch) {
    return this.store.updateAccount(id, patch, this.now());
  }

  // ── Seats ────────────────────────────────────────────────────────────

  /** Distinct direct seat holders of one live workspace. */
  async workspaceSeatUserIds(workspaceId: string): Promise<Set<string>> {
    const ws = await this.store.workspace(workspaceId);
    if (!ws || ws.deleted_at) return new Set();
    const ids = new Set<string>();
    for (const r of await this.store.directMemberships(workspaceId))
      if (r.user_id && r.source !== "staff_support" && SEAT_ROLES.has(r.role ?? ""))
        ids.add(r.user_id);
    return ids;
  }

  /**
   * Billable seats: distinct users across every workspace the account covers. Seats are
   * pooled, so someone in three of the account's workspaces is one seat, not three.
   */
  async countAccountSeats(accountId: string): Promise<number> {
    const ids = new Set<string>();
    for (const ws of await this.store.accountWorkspaceIds(accountId))
      for (const u of await this.workspaceSeatUserIds(ws)) ids.add(u);
    return ids.size;
  }

  /** Pending paid invites across the account (observers are free and not counted). */
  async countAccountPendingInvites(accountId: string): Promise<number> {
    let total = 0;
    for (const ws of await this.store.accountWorkspaceIds(accountId))
      for (const i of await this.store.pendingInvites(ws, this.now()))
        if ((i.role || "") !== "observer") total += 1;
    return total;
  }

  async accountActiveSeatEmails(accountId: string): Promise<Set<string>> {
    const emails = new Set<string>();
    for (const ws of await this.store.accountWorkspaceIds(accountId))
      for (const uid of await this.workspaceSeatUserIds(ws)) {
        const email = (await this.store.appUser(uid))?.email;
        if (email) emails.add(email.trim().toLowerCase());
      }
    return emails;
  }

  async accountPendingInviteEmails(accountId: string): Promise<Set<string>> {
    const emails = new Set<string>();
    for (const ws of await this.store.accountWorkspaceIds(accountId))
      for (const i of await this.store.pendingInvites(ws, this.now())) {
        if ((i.role || "") === "observer") continue;
        if (i.email) emails.add(i.email.trim().toLowerCase());
      }
    return emails;
  }

  /** Net-new seats for invite recipients: existing seat holders and pending invitees add nothing. */
  async countNetNewSeats(accountId: string, recipients: readonly string[]): Promise<number> {
    const cleaned = new Set(recipients.filter((e) => e?.trim()).map((e) => e.trim().toLowerCase()));
    if (!cleaned.size) return 0;
    const already = await this.accountActiveSeatEmails(accountId);
    for (const e of await this.accountPendingInviteEmails(accountId)) already.add(e);
    return [...cleaned].filter((e) => !already.has(e)).length;
  }

  // ── Read models ──────────────────────────────────────────────────────

  async listAccountInvoices(accountId: string, limit = 20, fromId: string | null = null) {
    const account = await this.store.account(accountId);
    const customerId = account?.mollie_customer_id;
    if (!customerId) return { invoices: [], next: null };
    const shown: MollieObject[] = [];
    let cursor = fromId;
    let first = true;
    for (let i = 0; i < LEDGER_MAX_FETCHES; i++) {
      const raw = await this.mollie.listCustomerPayments(customerId, {
        limit: LEDGER_FETCH,
        fromId: cursor,
      });
      if (!raw.length) break;
      // Mollie's `from` is inclusive: a continued fetch repeats the cursor row.
      const window = first ? raw : raw[0]?.id === cursor ? raw.slice(1) : raw;
      first = false;
      for (const p of window) {
        if (meta(p).intent === "update_payment_method") continue;
        shown.push(p);
        if (shown.length > limit) break;
      }
      if (shown.length > limit || raw.length < LEDGER_FETCH) break;
      cursor = raw.at(-1)?.id ?? null;
    }
    const next = shown.length > limit ? (shown[limit]?.id ?? null) : null;
    return { invoices: shown.slice(0, limit).map(invoiceRow), next };
  }

  async latestMethodUpdateStatus(accountId: string): Promise<string | null> {
    const account = await this.store.account(accountId);
    const customerId = account?.mollie_customer_id;
    if (!customerId) return null;
    for (const p of await this.mollie.listCustomerPayments(customerId, { limit: LEDGER_FETCH }))
      if (meta(p).intent === "update_payment_method") return str(p.status);
    return null;
  }

  async pendingCheckoutUrl(accountId: string): Promise<string | null> {
    const account = await this.store.account(accountId);
    const customerId = account?.mollie_customer_id;
    if (!customerId || account?.status !== "pending") return null;
    let payments: MollieObject[];
    try {
      payments = await this.mollie.listCustomerPayments(customerId, { limit: LEDGER_FETCH });
    } catch (e) {
      if (e instanceof MollieError) return null;
      throw e;
    }
    for (const p of payments) {
      const m = meta(p);
      if (
        p.sequenceType === "first" &&
        (p.status === "open" || p.status === "pending") &&
        m.intent === "activate" &&
        m.billing_account_id === accountId
      )
        return checkoutUrl(p);
    }
    return null;
  }

  async accountManager(
    account: AccountRow,
  ): Promise<{ name: string | null; email: string | null } | null> {
    if (!account.account_manager_id) return null;
    const user = await this.store.appUser(account.account_manager_id);
    if (!user) return null;
    return { name: user.display_name || user.email, email: user.email };
  }

  /** Everything the billing page shows: plan, seats, next invoice, projections, payment method. */
  async overview(accountId: string): Promise<Record<string, unknown>> {
    const account = await this.store.account(accountId);
    if (!account) return {};
    const tier = account.tier || "free";
    const billingPeriod = account.billing_period || "annual";
    const status = account.status;
    const pct = account.percent_discount;
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    const customerId = account.mollie_customer_id;
    const subId = account.mollie_subscription_id;
    const managed = isManaged(account);

    let projected: number | null = null;
    let perSeat: number | null = null;
    const cap = getCapacity(tier);
    if (cap && cap.priceEurMonthly !== null) {
      perSeat =
        billingPeriod === "monthly"
          ? computeMonthlyBillingPrice(cap.priceEurMonthly)
          : cap.priceEurMonthly;
      projected = applyDiscount(perSeat * seats, pct);
    }

    let nextInvoice: Record<string, unknown> | null = null;
    let paymentMethod: Record<string, unknown> | null = null;
    if (managed) {
      const amt = managedNextInvoiceAmount(account, seats);
      if (amt !== null) nextInvoice = { date: null, amount: money2(amt), currency: "EUR" };
    } else if (customerId && subId) {
      try {
        const sub = await this.mollie.getSubscription({ customerId, subscriptionId: subId });
        const a = amountOf(sub);
        nextInvoice = {
          date: sub.nextPaymentDate ?? null,
          amount: a.value,
          currency: a.currency || "EUR",
        };
      } catch (e) {
        if (!(e instanceof MollieError)) throw e;
      }
    }
    if (customerId && !managed) {
      try {
        const mandates = await this.mollie.listMandates(customerId);
        const valid = mandates.find((m) => m.status === "valid") ?? mandates[0] ?? null;
        if (valid) paymentMethod = { type: valid.method ?? null, label: paymentMethodLabel(valid) };
      } catch (e) {
        if (!(e instanceof MollieError)) throw e;
      }
    }

    const pendingInvites = await this.countAccountPendingInvites(accountId);
    const projectedWithPending =
      perSeat !== null && pendingInvites > 0
        ? applyDiscount(perSeat * (seats + pendingInvites), pct)
        : null;
    const manager = await this.accountManager(account);
    const watermark = account.provisioned_seats;
    const available = watermark !== null ? Math.max(0, watermark - seats) : 0;
    const pendingUrl = status === "pending" ? await this.pendingCheckoutUrl(accountId) : null;

    return {
      tier,
      status,
      billing_period: billingPeriod,
      seats,
      available_seats: available,
      pending_checkout_url: pendingUrl,
      current_period_end: directusTime(account.tier_expires_at),
      next_invoice: nextInvoice,
      projected_monthly_eur: projected,
      per_seat_monthly_eur: perSeat,
      payment_method: paymentMethod,
      pending_invites: pendingInvites,
      projected_with_pending_eur: projectedWithPending,
      percent_discount: pct,
      type_discount: account.type_discount,
      reconcile_failed_at: directusTime(account.reconcile_failed_at),
      is_managed: managed,
      has_active_subscription: account.payment_mode === "mollie" && Boolean(subId),
      has_payment_history: Boolean(customerId),
      account_manager: manager,
      billing_details: billingDetailsFromAccount(account),
    };
  }

  async saveBillingDetails(
    accountId: string,
    details: Partial<Record<BillingDetailField, string | null>>,
  ) {
    const patch: Partial<Record<BillingDetailField, string | null>> = {};
    for (const f of BILLING_DETAIL_FIELDS) if (f in details) patch[f] = details[f] ?? null;
    if (Object.keys(patch).length) await this.update(accountId, patch);
    return patch;
  }

  /** Per-tier cost preview at the account's seat count, both cadences. */
  async estimate(accountId: string) {
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    const tiers: Record<string, Record<string, number>> = {};
    for (const tier of PAYABLE_TIERS) {
      const cap = getCapacity(tier);
      if (!cap || cap.priceEurMonthly === null) continue;
      const annual = cap.priceEurMonthly;
      const monthly = computeMonthlyBillingPrice(annual);
      tiers[tier] = {
        annual_per_seat_monthly: annual,
        monthly_per_seat: monthly,
        annual_total_yearly: annual * 12 * seats,
        monthly_total_monthly: monthly * seats,
      };
    }
    return { seats, tiers };
  }

  // ── Checkout and payment method ─────────────────────────────────────

  private async billingContact(account: AccountRow): Promise<[string, string]> {
    const name = account.label || "dembrane customer";
    let email = "billing@dembrane.com";
    if (account.created_by) {
      const user = await this.store.appUser(account.created_by);
      if (user?.email) email = user.email;
    }
    return [name, email];
  }

  private async ensureCustomer(account: AccountRow): Promise<string> {
    if (account.mollie_customer_id) return account.mollie_customer_id;
    const [name, email] = await this.billingContact(account);
    const customer = await this.mollie.createCustomer({
      name,
      email,
      metadata: { billing_account_id: account.id },
    });
    const id = String(customer.id);
    await this.update(account.id, { mollie_customer_id: id });
    return id;
  }

  /**
   * Starts a subscription: ensures a Mollie customer and returns the hosted checkout of
   * the consent payment. The subscription is created when that payment clears.
   */
  async startSubscriptionCheckout(
    accountId: string,
    p: { tier: string; billingPeriod: string; redirectUrl: string },
  ): Promise<string> {
    if (!this.mollie.enabled)
      throw new BillingError("Mollie is not configured", "billing.payments_unavailable");
    if (!PURCHASABLE_TIERS.has(p.tier))
      throw new BillingError(
        `tier ${p.tier} is not available for checkout`,
        "billing.tier_not_purchasable",
        { tier: p.tier },
      );
    if (!this.d.config.webhookUrl)
      this.d.logger.warn(
        "MOLLIE_WEBHOOK_URL is not set: Mollie cannot push payment updates; relying on /sync and the reconcile schedule",
      );
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    if (account.mollie_subscription_id && ["active", "past_due"].includes(account.status ?? ""))
      throw new BillingError(
        "this account already has an active subscription",
        "billing.already_subscribed",
      );

    const seats = await this.countAccountSeats(accountId);
    const { amount: full, interval } = perIntervalAmount(p.tier, seats, p.billingPeriod);
    const amount = applyDiscount(full, account.percent_discount);
    const customerId = await this.ensureCustomer(account);

    // Reuse an in-flight consent payment: two paid consents would be a double charge.
    try {
      for (const existing of await this.mollie.listCustomerPayments(customerId)) {
        const m = meta(existing);
        if (
          existing.sequenceType === "first" &&
          (existing.status === "open" || existing.status === "pending") &&
          m.intent === "activate" &&
          m.billing_account_id === accountId
        ) {
          const url = checkoutUrl(existing);
          if (url) return url;
        }
      }
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      this.d.logger.warn({ err: e, accountId }, "could not check for an in-flight consent payment");
    }

    const payment = await this.mollie.createFirstPayment({
      customerId,
      amountEur: amount,
      description: planDescription(p.tier, seats, p.billingPeriod),
      redirectUrl: p.redirectUrl,
      webhookUrl: this.d.config.webhookUrl,
      metadata: {
        billing_account_id: accountId,
        intent: "activate",
        tier: p.tier,
        billing_period: p.billingPeriod,
        interval,
        seats,
        amount_eur: amount,
      },
    });
    await this.update(accountId, { status: "pending" });
    const url = checkoutUrl(payment);
    if (!url)
      throw new BillingError("Mollie did not return a checkout URL", "billing.checkout_failed");
    return url;
  }

  /** A EUR 0 consent payment that captures a new mandate; never creates a subscription. */
  async startUpdatePaymentMethod(accountId: string, redirectUrl: string): Promise<string> {
    if (!this.mollie.enabled)
      throw new BillingError("Mollie is not configured", "billing.payments_unavailable");
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    if (!account.mollie_customer_id)
      throw new BillingError(
        "no payment profile to update; subscribe first",
        "billing.no_payment_profile",
      );
    const payment = await this.mollie.createFirstPayment({
      customerId: account.mollie_customer_id,
      amountEur: 0,
      description: "Update payment method. No charge.",
      redirectUrl,
      webhookUrl: this.d.config.webhookUrl,
      metadata: { billing_account_id: accountId, intent: "update_payment_method" },
    });
    const url = checkoutUrl(payment);
    if (!url)
      throw new BillingError("Mollie did not return a checkout URL", "billing.checkout_failed");
    return url;
  }

  /** Keeps only the newest valid mandate; the subscription rides the newest one. */
  async revokeSupersededMandates(customerId: string): Promise<number> {
    let mandates: MollieObject[];
    try {
      mandates = await this.mollie.listMandates(customerId);
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      this.d.logger.warn({ err: e }, "could not list mandates");
      return 0;
    }
    const valid = mandates.filter((m) => m.status === "valid");
    if (valid.length <= 1) return 0;
    valid.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    let revoked = 0;
    for (const stale of valid.slice(1)) {
      if (!stale.id) continue;
      try {
        await this.mollie.revokeMandate(customerId, stale.id);
        revoked += 1;
      } catch (e) {
        if (!(e instanceof MollieError)) throw e;
        this.d.logger.warn({ err: e, mandate: stale.id }, "could not revoke mandate");
      }
    }
    return revoked;
  }

  // ── Activation and sync ──────────────────────────────────────────────

  /** First payment cleared: create the subscription and activate. Idempotent under a lock. */
  async activateFromFirstPayment(
    accountId: string,
    m: Record<string, unknown>,
    customerId: string,
  ) {
    const ran = await this.d.tryLock(`billing:activation:${accountId}`, async () => {
      const account = await this.store.account(accountId);
      if (!account || account.mollie_subscription_id) return;
      const tier = str(m.tier) || account.tier;
      const interval = str(m.interval) || "12 months";
      const amount = Number(m.amount_eur || 0);
      const seats = Math.trunc(Number(m.seats || 1));
      const billingPeriod = str(m.billing_period) || "annual";
      const sub = await this.mollie.createSubscription({
        customerId,
        amountEur: amount,
        interval,
        description: planDescription(tier, seats, billingPeriod),
        // The consent payment covered period one; charging on the start date double-bills.
        startDate: subscriptionStartDate(billingPeriod, this.now()),
        webhookUrl: this.d.config.webhookUrl ?? "",
        metadata: { billing_account_id: accountId },
      });
      await this.update(accountId, {
        tier,
        status: "active",
        payment_mode: "mollie",
        mollie_subscription_id: str(sub.id),
        billing_period: str(m.billing_period),
        tier_expires_at: null,
        type_discount: null,
        provisioned_seats: seats,
        payment_failed_notified: false,
        reconcile_failed_at: null,
      });
      this.d.logger.info({ accountId, tier, subscription: sub.id }, "activated billing account");
      await this.d.capture(accountId, "server_subscription_activated", {
        billing_account_id: accountId,
        tier,
        billing_period: billingPeriod,
        amount_eur: amount,
        seats,
      });
    });
    if (ran === undefined) this.d.logger.info({ accountId }, "activation already in progress");
  }

  /** Brings status in line with Mollie after a return from checkout or a missed webhook. */
  async syncAccount(accountId: string): Promise<string> {
    const account = await this.store.account(accountId);
    if (!account) return "none";
    const customerId = account.mollie_customer_id;
    if (!customerId) return account.status || "none";
    const payments = await this.mollie.listCustomerPayments(customerId);
    const ours = (p: MollieObject) =>
      p.sequenceType === "first" && p.status === "paid" && meta(p).billing_account_id === accountId;
    if (payments.some((p) => ours(p) && meta(p).intent === "update_payment_method"))
      await this.revokeSupersededMandates(customerId);
    if (account.mollie_subscription_id) return account.status || "active";
    const firstPaid = payments.find((p) => ours(p) && meta(p).intent !== "update_payment_method");
    if (firstPaid) {
      await this.activateFromFirstPayment(accountId, meta(firstPaid), customerId);
      return "active";
    }
    return account.status || "pending";
  }

  // ── Seat reconcile ───────────────────────────────────────────────────

  /** Re-prices an active subscription to the live seat count; skips when unchanged. */
  async syncSubscriptionSeats(accountId: string): Promise<number | null> {
    const account = await this.store.account(accountId);
    if (account?.status !== "active") return null;
    const subId = account.mollie_subscription_id;
    const customerId = account.mollie_customer_id;
    const tier = account.tier;
    if (!subId || !customerId || !tier || tier === "free") return null;
    const billingPeriod = account.billing_period || "annual";
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    let amount: number;
    try {
      amount = perIntervalAmount(tier, seats, billingPeriod).amount;
    } catch (e) {
      if (e instanceof BillingError) return null;
      throw e;
    }
    amount = applyDiscount(amount, account.percent_discount);

    let current: number | null;
    try {
      const sub = await this.mollie.getSubscription({ customerId, subscriptionId: subId });
      const v = Number(amountOf(sub).value ?? 0);
      current = Number.isNaN(v) ? null : v;
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      current = null;
    }
    const now = this.now();
    if (current !== null && Math.abs(current - amount) < 0.01) {
      this.d.repriceMemo.set(accountId, null, now);
      return amount;
    }
    const rejected = this.d.repriceMemo.get(accountId, now);
    if (rejected !== null && Math.abs(rejected - amount) < 0.01)
      throw new RepriceRejectedError(
        `sub ${subId} re-price to ${money2(amount)} EUR still rejected by Mollie (account ${accountId}); waiting for the amount to change`,
        true,
      );
    try {
      await this.mollie.updateSubscriptionAmount({
        customerId,
        subscriptionId: subId,
        amountEur: amount,
      });
    } catch (e) {
      if (
        e instanceof MollieError &&
        e.statusCode !== null &&
        e.statusCode >= 400 &&
        e.statusCode < 500
      )
        this.d.repriceMemo.set(accountId, amount, now);
      throw e;
    }
    this.d.repriceMemo.set(accountId, null, now);
    this.d.logger.info({ accountId, amount, seats }, "re-priced subscription");
    return amount;
  }

  private async periodFractionRemaining(account: AccountRow): Promise<number> {
    const customerId = account.mollie_customer_id;
    const subId = account.mollie_subscription_id;
    const periodDays = PERIOD_DAYS[account.billing_period || "annual"] ?? 365;
    if (!customerId || !subId) return 0;
    let sub: MollieObject;
    try {
      sub = await this.mollie.getSubscription({ customerId, subscriptionId: subId });
    } catch (e) {
      if (e instanceof MollieError) return 0;
      throw e;
    }
    const next = str(sub.nextPaymentDate);
    if (!next) return 0;
    const nextDay = utcDayNumber(next);
    if (nextDay === null) return 0;
    const days = nextDay - Math.floor(this.now().getTime() / 86_400_000);
    if (days <= 0) return 0;
    return Math.min(days / periodDays, 1);
  }

  /**
   * One-off prorated charge for seats added mid-period, against the stored mandate.
   * Null when nothing is owed; throws ReconcileChargeError when a charge was owed but
   * could not be placed, so reconcile flags the account instead of staying silent.
   */
  private async chargeSeatProration(
    account: AccountRow,
    added: number,
    provisionedBefore: number | null,
  ): Promise<number | null> {
    if (added < 1) return null;
    const tier = account.tier;
    const customerId = account.mollie_customer_id as string;
    const billingPeriod = account.billing_period || "annual";
    const fraction = await this.periodFractionRemaining(account);
    if (fraction <= 0) return null;
    let full: number;
    try {
      full = perIntervalAmount(tier, added, billingPeriod).amount;
    } catch (e) {
      if (e instanceof BillingError) return null;
      throw e;
    }
    full = applyDiscount(full, account.percent_discount);
    const prorated = pyRound(full * fraction, 2);
    if (prorated < 0.01) return null;

    let mandates: MollieObject[];
    try {
      mandates = await this.mollie.listMandates(customerId);
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      throw new ReconcileChargeError(
        `Could not read mandates for account ${account.id}: ${e.message}`,
      );
    }
    const valid = mandates.find((m) => m.status === "valid");
    if (!valid) {
      await this.notifyPaymentFailed(account);
      throw new ReconcileChargeError(
        `No valid mandate on account ${account.id}; proration charge owed but unpayable`,
      );
    }
    try {
      await this.mollie.createRecurringPayment({
        customerId,
        amountEur: prorated,
        description: `${added} seat(s) added, prorated for the rest of this period`,
        mandateId: valid.id ?? null,
        webhookUrl: this.d.config.webhookUrl || null,
        metadata: {
          billing_account_id: account.id,
          intent: "seat_proration",
          added_seats: String(added),
          provisioned_before: provisionedBefore,
        },
      });
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      this.d.logger.error({ err: e, accountId: account.id }, "proration charge failed");
      await this.notifyPaymentFailed(account);
      throw new ReconcileChargeError(
        `Proration charge failed for account ${account.id}: ${e.message}`,
      );
    }
    this.d.logger.info({ accountId: account.id, prorated, added }, "charged seat proration");
    return prorated;
  }

  /** Flips reconcile_failed_at only on a real transition, keeping the first failure time. */
  private async setReconcileFailed(account: AccountRow, failed: boolean) {
    const currently = account.reconcile_failed_at !== null;
    if (failed && !currently)
      await this.update(account.id, { reconcile_failed_at: pyIso(this.now()) });
    else if (!failed && currently) await this.update(account.id, { reconcile_failed_at: null });
  }

  /**
   * Brings billing in line with live seats for one account. Re-prices the renewal both
   * ways; charges a prorated one-off for seats above the period's high-watermark; never
   * refunds mid-period. A Mollie failure flags the account and never blocks the seat
   * change. Managed accounts only record the count.
   */
  async reconcileAccountSeats(accountId: string): Promise<void> {
    const account = await this.store.account(accountId);
    if (account?.status !== "active") return;
    const tier = account.tier;
    if (!tier || tier === "free") return;
    if (isManaged(account)) {
      const current = Math.max(await this.countAccountSeats(accountId), 1);
      await this.update(accountId, { provisioned_seats: current });
      this.d.logger.info(
        { accountId, seats: current, nextInvoice: managedNextInvoiceAmount(account, current) },
        "managed reconcile (no charge)",
      );
      return;
    }
    if (!account.mollie_subscription_id) return;
    try {
      if (this.d.config.forceReconcileFailure && this.mollie.testMode)
        throw new ReconcileChargeError(
          `Forced reconcile failure (MOLLIE_FORCE_RECONCILE_FAILURE) on ${accountId}`,
        );
      await this.syncSubscriptionSeats(accountId);
      const current = Math.max(await this.countAccountSeats(accountId), 1);
      const provisioned = account.provisioned_seats;
      if (provisioned === null) {
        await this.update(accountId, { provisioned_seats: current });
        await this.setReconcileFailed(account, false);
        return;
      }
      if (current > provisioned) {
        const charged = await this.chargeSeatProration(account, current - provisioned, provisioned);
        if (charged !== null) await this.update(accountId, { provisioned_seats: current });
      }
    } catch (e) {
      if (!(e instanceof ReconcileChargeError) && !(e instanceof MollieError)) throw e;
      if (e instanceof RepriceRejectedError && e.repeated)
        this.d.logger.info({ accountId, err: e.message }, "seat reconcile still blocked");
      else this.d.logger.error({ accountId, err: e.message }, "seat reconcile failed");
      await this.setReconcileFailed(account, true);
      return;
    }
    await this.setReconcileFailed(account, false);
  }

  /** Invite dialog preview: the prorated charge now and how much the renewal rises. */
  async estimateSeatAddition(
    accountId: string,
    added = 1,
    recipients: readonly string[] | null = null,
  ) {
    const account = await this.store.account(accountId);
    const billingPeriod = account?.billing_period || "annual";
    const effective =
      recipients !== null ? await this.countNetNewSeats(accountId, recipients) : Math.max(0, added);
    const result = {
      active: false,
      added_seats: effective,
      billing_period: billingPeriod,
      currency: "EUR",
      prorated_now_eur: 0.0,
      recurring_delta_eur: 0.0,
      covered_by_existing_seats: 0,
    };
    if (account?.status !== "active") return result;
    const tier = account.tier;
    if (!tier || tier === "free" || !account.mollie_subscription_id) return result;
    if (effective < 1) return { ...result, active: true };
    const watermark = account.provisioned_seats;
    const chargeable =
      watermark === null
        ? effective
        : Math.max(0, Math.max(await this.countAccountSeats(accountId), 1) + effective - watermark);
    result.covered_by_existing_seats = effective - chargeable;
    let full: number;
    try {
      full = perIntervalAmount(tier, effective, billingPeriod).amount;
    } catch (e) {
      if (e instanceof BillingError) return result;
      throw e;
    }
    const fraction = await this.periodFractionRemaining(account);
    result.active = true;
    result.recurring_delta_eur = pyRound(applyDiscount(full, account.percent_discount), 2);
    if (chargeable > 0) {
      const c = perIntervalAmount(tier, chargeable, billingPeriod).amount;
      result.prorated_now_eur = pyRound(applyDiscount(c, account.percent_discount) * fraction, 2);
    }
    return result;
  }

  // ── Cancel, resume, retry ────────────────────────────────────────────

  /** Stops renewal but keeps the paid tier until the period ends; the expiry schedule reverts it. */
  async cancelSubscription(accountId: string, reason: string | null, feedback: string | null) {
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    const subId = account.mollie_subscription_id;
    const customerId = account.mollie_customer_id;
    if (!subId || !customerId) return account.status || "free";
    let periodEnd: string | null = null;
    try {
      const sub = await this.mollie.getSubscription({ customerId, subscriptionId: subId });
      const next = str(sub.nextPaymentDate);
      if (next) periodEnd = `${next}T00:00:00+00:00`;
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      this.d.logger.warn({ err: e.message, subId }, "could not read subscription before cancel");
    }
    try {
      await this.mollie.cancelSubscription({ customerId, subscriptionId: subId });
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      this.d.logger.warn({ err: e.message, subId }, "mollie cancel failed; winding down locally");
    }
    const expiresAt = periodEnd ?? periodEndIso(account.billing_period, this.now());
    this.d.logger.info({ accountId, expiresAt, reason, feedback }, "billing account cancelled");
    await this.update(accountId, {
      status: "canceled",
      payment_mode: "none",
      mollie_subscription_id: null,
      tier_expires_at: expiresAt,
      pre_warning_sent: false,
    });
    return "canceled";
  }

  /** Resumes a canceled plan inside its paid period without charging it again. */
  async resumeSubscription(accountId: string): Promise<{ resumed: boolean; status: string }> {
    if (!this.mollie.enabled)
      throw new BillingError("Mollie is not configured", "billing.payments_unavailable");
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    const status = account.status;
    const tier = account.tier;
    const customerId = account.mollie_customer_id;
    const billingPeriod = account.billing_period || "annual";
    const expiresAt = account.tier_expires_at;
    const expiry = parseTime(expiresAt);
    const within = expiry !== null && expiry > this.now();
    if (status !== "canceled" || !tier || tier === "free" || !customerId || !within)
      return { resumed: false, status: status || "none" };
    let mandates: MollieObject[];
    try {
      mandates = await this.mollie.listMandates(customerId);
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      return { resumed: false, status };
    }
    if (!mandates.some((m) => m.status === "valid")) return { resumed: false, status };
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    let amount: number;
    let interval: string;
    try {
      ({ amount, interval } = perIntervalAmount(tier, seats, billingPeriod));
    } catch (e) {
      if (e instanceof BillingError) return { resumed: false, status };
      throw e;
    }
    amount = applyDiscount(amount, account.percent_discount);
    // Starts at the existing period end: no charge now, no paid days lost.
    const startDate = (expiry as Date).toISOString().slice(0, 10);
    const sub = await this.mollie.createSubscription({
      customerId,
      amountEur: amount,
      interval,
      description: planDescription(tier, seats, billingPeriod),
      startDate,
      webhookUrl: this.d.config.webhookUrl ?? "",
      metadata: { billing_account_id: accountId },
    });
    await this.update(accountId, {
      status: "active",
      payment_mode: "mollie",
      mollie_subscription_id: str(sub.id),
      provisioned_seats: seats,
      payment_failed_notified: false,
      reconcile_failed_at: null,
    });
    this.d.logger.info({ accountId, subscription: sub.id, startDate }, "resumed billing account");
    return { resumed: true, status: "active" };
  }

  /**
   * Tells the account's owners and admins that a charge failed, once per past-due window
   * (payment_failed_notified). The plan stays active. Best effort: never throws.
   */
  async notifyPaymentFailed(account: AccountRow): Promise<void> {
    if (account.payment_failed_notified) return;
    const now = this.now();
    let audience: string[] = [];
    try {
      audience = await billingAccountAdmins(this.store, account);
    } catch (err) {
      this.d.logger.warn(
        { err, accountId: account.id },
        "could not resolve payment-failed audience",
      );
    }
    if (audience.length)
      await this.d.notifier.emitToAudience(
        audience,
        {
          eventCode: "PAYMENT_FAILED",
          title: "We couldn't charge your payment method",
          message:
            "Your last payment didn't go through. Update your payment method to keep your plan. Your access stays on while you sort it out.",
          action: "NAVIGATE_BILLING",
          refWorkspaceId: account.workspace_id,
          refOrgId: account.org_id,
        },
        now,
      );
    try {
      const recipients = await recipientsOf(this.store, audience);
      const base = this.d.config.dashboardUrl.replace(/\/+$/, "");
      const url = account.workspace_id
        ? `${base}/w/${account.workspace_id}/settings/billing`
        : account.org_id
          ? `${base}/o/${account.org_id}/settings/billing`
          : base || "/";
      for (const r of recipients)
        await this.d.mailer.send({
          to: r.email,
          ...paymentFailedEmail(url, r.locale),
          tags: ["payment_failed"],
        });
    } catch (err) {
      this.d.logger.warn({ err, accountId: account.id }, "payment-failed email failed");
    }
    try {
      await this.update(account.id, { payment_failed_notified: true });
    } catch (err) {
      this.d.logger.warn({ err, accountId: account.id }, "could not set payment_failed_notified");
    }
  }

  private async markPastDue(accountId: string) {
    const account = await this.store.account(accountId);
    if (!account) return;
    await this.update(accountId, { status: "past_due" });
    await this.notifyPaymentFailed(account);
  }

  private async markRecovered(accountId: string) {
    const account = await this.store.account(accountId);
    const patch: AccountPatch = { status: "active" };
    if (account?.payment_failed_notified) patch.payment_failed_notified = false;
    await this.update(accountId, patch);
  }

  /**
   * Retries the outstanding charge against the newest valid mandate. Only a settled
   * "paid" recovers; a pending charge waits for its webhook. Charges the undiscounted
   * plan amount, exactly as the old service did.
   */
  async retryCharge(accountId: string): Promise<string> {
    const account = await this.store.account(accountId);
    if (!account) return "none";
    if (account.status !== "past_due") return account.status || "none";
    const customerId = account.mollie_customer_id;
    const tier = account.tier;
    const billingPeriod = account.billing_period || "annual";
    if (!customerId || !tier || tier === "free") return "past_due";
    let mandates: MollieObject[];
    try {
      mandates = await this.mollie.listMandates(customerId);
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      return "past_due";
    }
    const valid = mandates.find((m) => m.status === "valid");
    if (!valid) return "past_due";
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    let amount: number;
    try {
      amount = perIntervalAmount(tier, seats, billingPeriod).amount;
    } catch (e) {
      if (e instanceof BillingError) return "past_due";
      throw e;
    }
    let payment: MollieObject;
    try {
      payment = await this.mollie.createRecurringPayment({
        customerId,
        amountEur: amount,
        description: planDescription(tier, seats, billingPeriod),
        mandateId: valid.id ?? null,
        webhookUrl: this.d.config.webhookUrl || null,
        metadata: { billing_account_id: accountId, intent: "retry_charge" },
      });
    } catch (e) {
      if (!(e instanceof MollieError)) throw e;
      return "past_due";
    }
    if (payment.status !== "paid") return "past_due";
    await this.markRecovered(accountId);
    return "active";
  }

  // ── Webhook ──────────────────────────────────────────────────────────

  /**
   * One Mollie payment update. The payment is re-fetched (the POST body is never
   * trusted) and routed by our own intent, then by shape. Idempotent.
   */
  async handleWebhook(paymentId: string): Promise<void> {
    const payment = await this.mollie.getPayment(paymentId);
    const m = meta(payment);
    const accountId = str(m.billing_account_id);
    if (!accountId) {
      this.d.logger.warn({ paymentId }, "mollie webhook without billing_account_id; ignoring");
      return;
    }
    const status = str(payment.status);
    const customerId = str(payment.customerId);
    const intent = m.intent;

    if (intent === "offline_invoice") {
      if (status === "paid")
        await this.update(accountId, {
          status: "active",
          payment_mode: "offline",
          tier_expires_at: null,
        });
      return;
    }
    if (intent === "retry_charge") {
      if (status === "paid") await this.markRecovered(accountId);
      else if (status && FAILED_STATUSES.has(status)) await this.markPastDue(accountId);
      return;
    }
    if (intent === "seat_proration") {
      if (!status || !FAILED_STATUSES.has(status)) return;
      const account = await this.store.account(accountId);
      if (!account) return;
      const before = m.provisioned_before;
      if (before !== null && before !== undefined)
        await this.update(accountId, { provisioned_seats: Math.trunc(Number(before)) });
      await this.setReconcileFailed(account, true);
      await this.notifyPaymentFailed(account);
      return;
    }
    if (intent === "update_payment_method") {
      if (status === "paid" && customerId) {
        await this.revokeSupersededMandates(customerId);
        await this.retryCharge(accountId);
      }
      return;
    }
    if (payment.sequenceType === "first") {
      if (status === "paid") {
        if (customerId) await this.activateFromFirstPayment(accountId, m, customerId);
        return;
      }
      if (status && FAILED_STATUSES.has(status)) {
        const account = await this.store.account(accountId);
        if (account?.status === "pending") await this.update(accountId, { status: "none" });
      }
      return;
    }
    if (payment.subscriptionId) {
      if (status === "paid") {
        await this.markRecovered(accountId);
        // A renewal opens a new period: the seat high-watermark restarts at the live count.
        await this.update(accountId, {
          provisioned_seats: Math.max(await this.countAccountSeats(accountId), 1),
        });
      } else if (status && FAILED_STATUSES.has(status)) await this.markPastDue(accountId);
      return;
    }
    this.d.logger.info(
      { paymentId, intent, status },
      "mollie webhook matched no handler; ignoring",
    );
  }

  // ── Managed accounts (staff) ─────────────────────────────────────────

  async issueOfflinePaymentLink(
    accountId: string,
    p: { amountEur: number | null; description: string | null; redirectUrl: string | null },
  ) {
    if (!this.mollie.enabled)
      throw new BillingError("Mollie is not configured", "billing.payments_unavailable");
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    const seats = Math.max(await this.countAccountSeats(accountId), 1);
    const amount = p.amountEur ?? managedNextInvoiceAmount(account, seats);
    if (amount === null || amount < 0.01)
      throw new BillingError("no invoice amount for this account", "billing.no_invoice_amount");
    const tier = account.tier || "managed";
    const link = await this.mollie.createPaymentLink({
      amountEur: amount,
      description:
        p.description || planDescription(tier, seats, account.billing_period || "annual"),
      webhookUrl: this.d.config.webhookUrl || null,
      redirectUrl: p.redirectUrl,
      metadata: { billing_account_id: accountId, intent: "offline_invoice", tier, seats },
    });
    const url = linkUrl(link);
    if (!url)
      throw new BillingError(
        "Mollie did not return a payment link URL",
        "billing.payment_link_failed",
      );
    return { payment_link_id: link.id ?? null, url, amount_eur: amount };
  }

  async issueSalesInvoice(
    accountId: string,
    p: {
      seats: number | null;
      amountEur: number | null;
      markPaid: boolean;
      isEInvoice: boolean;
      paymentDetails?: Record<string, unknown> | null;
    },
  ) {
    if (!this.mollie.enabled)
      throw new BillingError("Mollie is not configured", "billing.payments_unavailable");
    const account = await this.store.account(accountId);
    if (!account) throw new BillingError("billing account not found", "billing.account_not_found");
    const seats = p.seats ?? Math.max(await this.countAccountSeats(accountId), 1);
    const amount = p.amountEur ?? managedNextInvoiceAmount(account, seats);
    if (amount === null || amount < 0.01)
      throw new BillingError("no invoice amount for this account", "billing.no_invoice_amount");
    const tier = account.tier || "managed";
    const status = p.markPaid ? "paid" : "issued";
    const invoice = await this.mollie.createSalesInvoice({
      status,
      recipient: invoiceRecipient(account),
      lines: [
        {
          description: planDescription(tier, seats, account.billing_period || "annual"),
          quantity: 1,
          vatRate: "0.00",
          unitPrice: { currency: "EUR", value: money2(amount) },
        },
      ],
      paymentDetails: p.markPaid ? (p.paymentDetails ?? null) : null,
      isEInvoice: p.isEInvoice,
      metadata: { billing_account_id: accountId, tier, seats },
    });
    return { invoice_id: invoice.id ?? null, status: str(invoice.status) || status };
  }

  /**
   * The PDF of one of this account's sales invoices. An invoice issued for another
   * account answers null, so an account id cannot unlock someone else's invoice
   * (spec 7 M-17).
   */
  async salesInvoicePdfUrlFor(accountId: string, invoiceId: string): Promise<string | null> {
    const inv = await this.mollie.getSalesInvoice(invoiceId);
    if (meta(inv).billing_account_id !== accountId) return null;
    const links = (inv._links ?? {}) as Record<string, { href?: string } | undefined>;
    return links.pdfLink?.href ?? null;
  }
}

function linkUrl(link: MollieObject): string | null {
  const links = (link._links ?? {}) as Record<string, { href?: string } | undefined>;
  return links.paymentLink?.href ?? null;
}

function invoiceRow(p: MollieObject) {
  const a = amountOf(p);
  const status = str(p.status);
  return {
    id: p.id ?? null,
    created_at: p.createdAt ?? null,
    amount: a.value,
    currency: a.currency,
    status,
    description: str(p.description) || "",
    pay_url: status === "open" || status === "pending" ? checkoutUrl(p) : null,
  };
}

export function paymentMethodLabel(mandate: MollieObject): string {
  const method = str(mandate.method);
  const details = (mandate.details ?? {}) as Record<string, unknown>;
  if (method === "creditcard") {
    const last4 = str(details.cardNumber) || str(details.cardLabel);
    return last4 ? `Card ending ${last4}` : "Card";
  }
  if (method === "directdebit") {
    const acct = str(details.consumerAccount);
    const tail = acct ? acct.slice(-4) : null;
    return tail ? `SEPA Direct Debit, account ending ${tail}` : "SEPA Direct Debit";
  }
  return method || "Unknown";
}

/** The sales-invoice recipient from the captured VAT and address; empty values are dropped. */
export function invoiceRecipient(account: AccountRow): Record<string, unknown> {
  const r: Record<string, unknown> = {
    type: account.billing_vat_id ? "business" : "consumer",
    organizationName: account.billing_legal_name || account.label,
    streetAndNumber: account.billing_address_line1,
    postalCode: account.billing_postal_code,
    city: account.billing_city,
    country: account.billing_country,
  };
  if (account.billing_address_line2) r.streetAdditional = account.billing_address_line2;
  if (account.billing_vat_id) r.vatNumber = account.billing_vat_id;
  return Object.fromEntries(Object.entries(r).filter(([, v]) => Boolean(v)));
}

/** Days since the epoch of a YYYY-MM-DD (or ISO) date, read as a UTC calendar day. */
function utcDayNumber(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}
