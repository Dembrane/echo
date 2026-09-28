import { describe, expect, test } from "bun:test";
import { MollieError } from "../src";
import { ACC, NOW, ORG, U, WS1, world } from "./helpers";

const back = "https://dash.test/back";

describe("seats", () => {
  test("seats are distinct direct seat holders across the account; observers and staff rows are free", async () => {
    const w = world();
    w.store.memberships.push({
      id: "e1000000-0000-4000-8000-000000000099",
      workspace_id: WS1,
      user_id: "a0000000-0000-4000-8000-000000000099",
      role: "admin",
      source: "staff_support",
    });
    expect(await w.service.countAccountSeats(ACC)).toBe(4);
  });

  test("net-new seats skip current seat holders and pending invitees", async () => {
    const w = world();
    w.store.invites.push({
      id: "i1",
      workspace_id: WS1,
      email: "Pending@x.test",
      role: "member",
      expires_at: "2026-10-30T00:00:00Z",
    });
    expect(
      await w.service.countNetNewSeats(ACC, [
        "member@acme.test",
        " pending@x.test",
        "new@x.test",
        "",
      ]),
    ).toBe(1);
  });
});

describe("checkout", () => {
  test("creates the customer from the creator, charges the discounted first period and marks pending", async () => {
    const w = world({ percent_discount: 10 });
    const url = await w.service.startSubscriptionCheckout(ACC, {
      tier: "changemaker",
      billingPeriod: "monthly",
      redirectUrl: back,
    });
    expect(url).toStartWith("https://mollie.test/checkout/");
    const [customer] = w.mollie.callsOf("createCustomer") as { email: string; name: string }[];
    expect(customer).toMatchObject({ email: "owner@acme.test", name: "Acme" });
    const [first] = w.mollie.callsOf("createFirstPayment") as Record<string, unknown>[];
    expect(first).toMatchObject({
      amountEur: 309.6, // 4 seats x EUR 86, less 10%
      description: "Changemaker plan. 4 seats, billed monthly, renews monthly. Cancel anytime.",
      redirectUrl: back,
      metadata: {
        billing_account_id: ACC,
        intent: "activate",
        tier: "changemaker",
        billing_period: "monthly",
        interval: "1 month",
        seats: 4,
        amount_eur: 309.6,
      },
    });
    expect(w.acc().status).toBe("pending");
    expect(w.acc().mollie_customer_id).toBe(String(w.mollie.customers.keys().next().value));
  });

  test("a second click reuses the in-flight consent instead of charging twice", async () => {
    const w = world();
    const p = { tier: "changemaker", billingPeriod: "annual", redirectUrl: back };
    const a = await w.service.startSubscriptionCheckout(ACC, p);
    const b = await w.service.startSubscriptionCheckout(ACC, p);
    expect(b).toBe(a);
    expect(w.mollie.callsOf("createFirstPayment")).toHaveLength(1);
    expect(w.mollie.callsOf("createCustomer")).toHaveLength(1);
  });

  test("coming-soon tiers and live subscriptions are refused", async () => {
    const w = world();
    await expect(
      w.service.startSubscriptionCheckout(ACC, {
        tier: "guardian",
        billingPeriod: "annual",
        redirectUrl: back,
      }),
    ).rejects.toThrow("tier guardian is not available for checkout");
    const live = world({ mollie_subscription_id: "sub_1", status: "past_due" });
    await expect(
      live.service.startSubscriptionCheckout(ACC, {
        tier: "changemaker",
        billingPeriod: "annual",
        redirectUrl: back,
      }),
    ).rejects.toThrow("this account already has an active subscription");
  });
});

async function checkedOut(billingPeriod = "annual", account = {}) {
  const w = world(account);
  await w.service.startSubscriptionCheckout(ACC, {
    tier: "changemaker",
    billingPeriod,
    redirectUrl: back,
  });
  const paymentId = [...w.mollie.payments.keys()][0] as string;
  return { ...w, paymentId };
}

describe("webhook", () => {
  test("a paid consent creates the subscription one period out and activates, once", async () => {
    const w = await checkedOut("annual", {
      type_discount: "trial",
      tier_expires_at: "2026-10-01T00:00:00Z",
    });
    w.mollie.settle(w.paymentId, "paid");
    await w.service.handleWebhook(w.paymentId);
    await w.service.handleWebhook(w.paymentId);
    const subs = w.mollie.callsOf("createSubscription") as Record<string, unknown>[];
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      amountEur: 3600,
      interval: "12 months",
      startDate: "2027-09-27",
      metadata: { billing_account_id: ACC },
    });
    expect(w.acc()).toMatchObject({
      tier: "changemaker",
      status: "active",
      payment_mode: "mollie",
      billing_period: "annual",
      tier_expires_at: null,
      type_discount: null,
      provisioned_seats: 4,
      payment_failed_notified: false,
      reconcile_failed_at: null,
    });
  });

  test("activation is skipped while another caller holds the lock", async () => {
    const w = await checkedOut();
    w.mollie.settle(w.paymentId, "paid");
    w.held.add(`billing:activation:${ACC}`);
    await w.service.handleWebhook(w.paymentId);
    expect(w.mollie.callsOf("createSubscription")).toHaveLength(0);
  });

  test("a failed consent rolls pending back to none but never downgrades a live account", async () => {
    const w = await checkedOut();
    w.mollie.settle(w.paymentId, "expired");
    await w.service.handleWebhook(w.paymentId);
    expect(w.acc().status).toBe("none");
    await w.store.updateAccount(ACC, { status: "active" }, NOW);
    await w.service.handleWebhook(w.paymentId);
    expect(w.acc().status).toBe("active");
  });

  test("a paid renewal recovers and resets the seat watermark to the live count", async () => {
    const w = await checkedOut();
    w.mollie.settle(w.paymentId, "paid");
    await w.service.handleWebhook(w.paymentId);
    await w.store.updateAccount(
      ACC,
      { status: "past_due", payment_failed_notified: true, provisioned_seats: 9 },
      NOW,
    );
    const sub = w.acc().mollie_subscription_id as string;
    const renewal = w.mollie.renew(sub, "paid");
    await w.service.handleWebhook(renewal.id as string);
    expect(w.acc()).toMatchObject({
      status: "active",
      payment_failed_notified: false,
      provisioned_seats: 4,
    });
  });

  test("a failed renewal marks past due and notifies owners and admins exactly once", async () => {
    const w = await checkedOut();
    w.mollie.settle(w.paymentId, "paid");
    await w.service.handleWebhook(w.paymentId);
    const sub = w.acc().mollie_subscription_id as string;
    await w.service.handleWebhook(w.mollie.renew(sub, "failed").id as string);
    await w.service.handleWebhook(w.mollie.renew(sub, "failed").id as string);
    expect(w.acc()).toMatchObject({ status: "past_due", payment_failed_notified: true });
    expect(
      w.store.notifications.map((n) => [n.audience_user_id, n.event_code, n.severity, n.action]),
    ).toEqual([
      [U.owner, "PAYMENT_FAILED", "action_required", "NAVIGATE_BILLING"],
      [U.admin, "PAYMENT_FAILED", "action_required", "NAVIGATE_BILLING"],
    ]);
    expect(w.store.notifications[0]?.scope).toBe("Acme");
    expect(w.mailer.sent.map((m) => m.to)).toEqual(["admin@acme.test", "owner@acme.test"]);
    expect(w.mailer.sent[0]?.subject).toBe("Action needed: update your payment method");
    expect(w.mailer.sent[0]?.text).toContain(`https://dash.test/o/${ORG}/settings/billing`);
  });

  test("a paid method update revokes older mandates and retries the outstanding charge", async () => {
    const w = await checkedOut();
    w.mollie.settle(w.paymentId, "paid");
    await w.service.handleWebhook(w.paymentId);
    const customer = w.acc().mollie_customer_id as string;
    await w.store.updateAccount(ACC, { status: "past_due" }, NOW);
    await w.service.startUpdatePaymentMethod(ACC, back);
    const consent = [...w.mollie.payments.values()].at(-1)?.id as string;
    w.mollie.settle(consent, "paid");
    await w.service.handleWebhook(consent);
    const mandates = w.mollie.mandates.get(customer) ?? [];
    expect(mandates.filter((m) => m.status === "valid")).toHaveLength(1);
    expect(mandates.filter((m) => m.status === "revoked")).toHaveLength(1);
    const [retry] = w.mollie.callsOf("createRecurringPayment") as Record<string, unknown>[];
    expect(retry).toMatchObject({ amountEur: 3600, metadata: { intent: "retry_charge" } });
    expect(w.acc().status).toBe("active");
    expect(w.mollie.callsOf("createSubscription")).toHaveLength(1);
  });

  test("offline invoices keep managed accounts active; unknown payments are ignored", async () => {
    const w = world({
      payment_mode: "offline",
      status: "none",
      tier_expires_at: "2026-10-01T00:00:00Z",
    });
    const link = await w.service.issueOfflinePaymentLink(ACC, {
      amountEur: null,
      description: null,
      redirectUrl: null,
    });
    expect(link).toMatchObject({ amount_eur: 3600 });
    const p = await w.mollie.createRecurringPayment({
      customerId: "cst_x",
      amountEur: 3600,
      description: "x",
      metadata: { billing_account_id: ACC, intent: "offline_invoice" },
    });
    await w.service.handleWebhook(p.id as string);
    expect(w.acc()).toMatchObject({
      status: "active",
      payment_mode: "offline",
      tier_expires_at: null,
    });
    const stray = await w.mollie.createRecurringPayment({
      customerId: "c",
      amountEur: 1,
      description: "x",
    });
    await w.service.handleWebhook(stray.id as string);
    await expect(w.service.handleWebhook("tr_missing")).rejects.toBeInstanceOf(MollieError);
  });
});

describe("seat reconcile", () => {
  async function active(extra = {}) {
    const w = world({
      status: "active",
      payment_mode: "mollie",
      billing_period: "annual",
      mollie_customer_id: "cst_1",
      ...extra,
    });
    const sub = await w.mollie.createSubscription({
      customerId: "cst_1",
      amountEur: 900,
      interval: "12 months",
      description: "x",
      startDate: "2027-03-28", // 182 days after NOW
    });
    await w.store.updateAccount(ACC, { mollie_subscription_id: sub.id as string }, NOW);
    w.mollie.calls.length = 0;
    return { ...w, subId: sub.id as string };
  }

  test("re-prices the renewal and charges the added seats pro rata above the watermark", async () => {
    const w = await active({ provisioned_seats: 2, percent_discount: 50 });
    w.mollie.addMandate("cst_1");
    await w.service.reconcileAccountSeats(ACC);
    expect(w.mollie.callsOf("updateSubscriptionAmount")).toEqual([
      { customerId: "cst_1", subscriptionId: w.subId, amountEur: 1800 }, // 4 x 75 x 12, less 50%
    ]);
    const [charge] = w.mollie.callsOf("createRecurringPayment") as Record<string, unknown>[];
    // 2 added seats: 1800 x 50% = 900, x 182/365 remaining
    expect(charge).toMatchObject({
      amountEur: 448.77,
      description: "2 seat(s) added, prorated for the rest of this period",
      metadata: { intent: "seat_proration", added_seats: "2", provisioned_before: 2 },
    });
    expect(w.acc().provisioned_seats).toBe(4);
    expect(w.acc().reconcile_failed_at).toBeNull();
  });

  test("the first reconcile only sets the baseline", async () => {
    const w = await active();
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().provisioned_seats).toBe(4);
    expect(w.mollie.callsOf("createRecurringPayment")).toHaveLength(0);
  });

  test("a dead mandate flags the account, keeps the baseline and notifies", async () => {
    const w = await active({ provisioned_seats: 2 });
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().provisioned_seats).toBe(2);
    expect(w.acc().reconcile_failed_at).not.toBeNull();
    expect(w.acc().payment_failed_notified).toBe(true);
    const flaggedAt = w.acc().reconcile_failed_at;
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().reconcile_failed_at).toBe(flaggedAt);
    w.mollie.addMandate("cst_1");
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().reconcile_failed_at).toBeNull();
  });

  test("an amount Mollie refused is not re-sent until it changes", async () => {
    const w = await active({ provisioned_seats: 4 });
    w.mollie.failNext("updateSubscriptionAmount", new MollieError("above maximum", 422));
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().reconcile_failed_at).not.toBeNull();
    await w.service.reconcileAccountSeats(ACC);
    expect(w.mollie.callsOf("updateSubscriptionAmount")).toHaveLength(1);
  });

  test("managed accounts only record the seat count", async () => {
    const w = await active({ payment_mode: "offline", provisioned_seats: 1 });
    await w.service.reconcileAccountSeats(ACC);
    expect(w.acc().provisioned_seats).toBe(4);
    expect(w.mollie.calls).toHaveLength(0);
  });

  test("a failed proration charge rolls the watermark back and flags", async () => {
    const w = await active({ provisioned_seats: 2 });
    const p = await w.mollie.createRecurringPayment({
      customerId: "cst_1",
      amountEur: 10,
      description: "x",
      metadata: { billing_account_id: ACC, intent: "seat_proration", provisioned_before: 2 },
    });
    await w.store.updateAccount(ACC, { provisioned_seats: 4 }, NOW);
    w.mollie.settle(p.id as string, "failed");
    await w.service.handleWebhook(p.id as string);
    expect(w.acc().provisioned_seats).toBe(2);
    expect(w.acc().reconcile_failed_at).not.toBeNull();
  });

  test("the invite preview matches what reconcile would charge", async () => {
    const w = await active({ provisioned_seats: 5 });
    const est = await w.service.estimateSeatAddition(ACC, 3);
    expect(est).toEqual({
      active: true,
      added_seats: 3,
      billing_period: "annual",
      currency: "EUR",
      prorated_now_eur: 897.53, // 2 seats beyond the watermark: 1800 x 182/365
      recurring_delta_eur: 2700,
      covered_by_existing_seats: 1,
    });
  });
});

describe("cancel, resume, retry", () => {
  test("cancel keeps the paid tier until the period end Mollie reports", async () => {
    const w = world({ status: "active", payment_mode: "mollie", mollie_customer_id: "cst_1" });
    const sub = await w.mollie.createSubscription({
      customerId: "cst_1",
      amountEur: 1,
      interval: "12 months",
      description: "x",
      startDate: "2027-01-15",
    });
    await w.store.updateAccount(ACC, { mollie_subscription_id: sub.id as string }, NOW);
    expect(await w.service.cancelSubscription(ACC, "too_expensive", null)).toBe("canceled");
    expect(w.acc()).toMatchObject({
      status: "canceled",
      payment_mode: "none",
      mollie_subscription_id: null,
      tier: "changemaker",
      tier_expires_at: "2027-01-15T00:00:00+00:00",
      pre_warning_sent: false,
    });
    expect(w.mollie.subscriptions.get(sub.id as string)?.status).toBe("canceled");
    expect(await world().service.cancelSubscription(ACC, null, null)).toBe("none");
  });

  test("resume inside the paid period starts a new subscription at the period end, no charge", async () => {
    const w = world({
      status: "canceled",
      mollie_customer_id: "cst_1",
      billing_period: "monthly",
      tier_expires_at: "2026-10-15T00:00:00+00:00",
      percent_discount: 25,
    });
    expect(await w.service.resumeSubscription(ACC)).toEqual({ resumed: false, status: "canceled" });
    w.mollie.addMandate("cst_1");
    expect(await w.service.resumeSubscription(ACC)).toEqual({ resumed: true, status: "active" });
    expect(w.mollie.callsOf("createSubscription")).toEqual([
      expect.objectContaining({ amountEur: 258, interval: "1 month", startDate: "2026-10-15" }),
    ]);
    expect(w.mollie.callsOf("createFirstPayment")).toHaveLength(0);
    expect(w.acc()).toMatchObject({
      status: "active",
      payment_mode: "mollie",
      provisioned_seats: 4,
    });
    const lapsed = world({
      status: "canceled",
      mollie_customer_id: "c",
      tier_expires_at: "2026-09-01T00:00:00Z",
    });
    expect(await lapsed.service.resumeSubscription(ACC)).toEqual({
      resumed: false,
      status: "canceled",
    });
  });

  test("retry charges the full plan amount and only a paid charge recovers", async () => {
    const w = world({ status: "past_due", mollie_customer_id: "cst_1", percent_discount: 50 });
    expect(await w.service.retryCharge(ACC)).toBe("past_due"); // no mandate
    w.mollie.addMandate("cst_1");
    w.mollie.recurringStatus = "pending";
    expect(await w.service.retryCharge(ACC)).toBe("past_due");
    w.mollie.recurringStatus = "paid";
    expect(await w.service.retryCharge(ACC)).toBe("active");
    const charges = w.mollie.callsOf("createRecurringPayment") as { amountEur: number }[];
    expect(charges.map((c) => c.amountEur)).toEqual([3600, 3600]);
    expect(await world({ status: "active" }).service.retryCharge(ACC)).toBe("active");
  });
});

describe("read models", () => {
  test("the invoice ledger hides method updates and pages with an inclusive cursor", async () => {
    const w = world({ mollie_customer_id: "cst_1" });
    for (let i = 0; i < 5; i++)
      await w.mollie.createRecurringPayment({
        customerId: "cst_1",
        amountEur: 10 + i,
        description: `charge ${i}`,
        metadata: i === 3 ? { intent: "update_payment_method" } : {},
      });
    const page = await w.service.listAccountInvoices(ACC, 2);
    expect(page.invoices.map((r) => r.description)).toEqual(["charge 4", "charge 2"]);
    const next = await w.service.listAccountInvoices(ACC, 2, page.next);
    expect(next.invoices.map((r) => r.description)).toEqual(["charge 1", "charge 0"]);
    expect(next.next).toBeNull();
  });

  test("overview of a live subscription shows Mollie's amount and the card", async () => {
    const w = world({
      status: "active",
      payment_mode: "mollie",
      mollie_customer_id: "cst_1",
      percent_discount: 20,
    });
    const sub = await w.mollie.createSubscription({
      customerId: "cst_1",
      amountEur: 2880,
      interval: "12 months",
      description: "x",
      startDate: "2027-09-27",
    });
    await w.store.updateAccount(
      ACC,
      { mollie_subscription_id: sub.id as string, provisioned_seats: 6 },
      NOW,
    );
    w.mollie.addMandate("cst_1", {
      status: "invalid",
      method: "directdebit",
      details: { consumerAccount: "NL00BANK0123456789" },
    });
    w.mollie.addMandate("cst_1");
    const o = await w.service.overview(ACC);
    expect(o).toMatchObject({
      seats: 4,
      available_seats: 2,
      next_invoice: { date: "2027-09-27", amount: "2880.00", currency: "EUR" },
      projected_monthly_eur: 240,
      per_seat_monthly_eur: 75,
      payment_method: { type: "creditcard", label: "Card ending 4242" },
      has_active_subscription: true,
      has_payment_history: true,
      is_managed: false,
    });
  });

  test("managed overview derives the next invoice from seats without calling Mollie", async () => {
    const w = world({
      payment_mode: "offline",
      billing_period: "monthly",
      account_manager_id: U.admin,
    });
    const o = await w.service.overview(ACC);
    expect(o).toMatchObject({
      next_invoice: { date: null, amount: "344.00", currency: "EUR" },
      is_managed: true,
      account_manager: { name: "admin", email: "admin@acme.test" },
    });
    expect(w.mollie.calls).toHaveLength(0);
  });

  test("a sales invoice PDF is only served for the account it was issued to", async () => {
    const w = world({ payment_mode: "offline" });
    const inv = await w.service.issueSalesInvoice(ACC, {
      seats: 3,
      amountEur: null,
      markPaid: false,
      isEInvoice: true,
    });
    expect(inv).toEqual({ invoice_id: expect.any(String), status: "issued" });
    const [call] = w.mollie.callsOf("createSalesInvoice") as Record<string, unknown>[];
    expect(call).toMatchObject({
      recipient: { type: "consumer", organizationName: "Acme" },
      lines: [{ quantity: 1, vatRate: "0.00", unitPrice: { currency: "EUR", value: "2700.00" } }],
      isEInvoice: true,
    });
    expect(await w.service.salesInvoicePdfUrlFor(ACC, inv.invoice_id as string)).toStartWith(
      "https://mollie.test/",
    );
    expect(
      await w.service.salesInvoicePdfUrlFor(
        "ba000000-0000-4000-8000-000000000002",
        inv.invoice_id as string,
      ),
    ).toBeNull();
  });
});
