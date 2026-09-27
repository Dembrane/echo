import { describe, expect, test } from "bun:test";
import {
  BILLING_SCHEDULES,
  type Billing,
  formatExpiryDate,
  runExpireTiers,
  runReconcilePending,
  runReconcileSeats,
  runTierPrewarning,
} from "../src";
import { ACC, logger, logLines, NOW, U, WS1, WS2, world } from "./helpers";

function deps(w: ReturnType<typeof world>, customerJobs = true) {
  const billing: Billing = {
    service: w.service,
    store: w.store,
    notifier: w.notifier,
    mollie: w.mollie,
  };
  return {
    billing,
    mailer: w.mailer,
    logger,
    customerJobs,
    dashboardUrl: "https://dash.test",
    clock: () => NOW,
  };
}

test("schedules keep the old cadence", () => {
  expect(BILLING_SCHEDULES.map(([j, c]) => [j.name, c, j.policy])).toEqual([
    ["billing.reconcile-pending", "*/5 * * * *", "singleton"],
    ["billing.reconcile-seats", "*/15 * * * *", "singleton"],
    ["billing.expire-tiers", "0 * * * *", "singleton"],
    ["billing.tier-prewarning", "0 * * * *", "singleton"],
  ]);
});

describe("customer jobs switch", () => {
  test("with customer jobs off nothing is read, charged, changed or sent", async () => {
    const w = world({
      tier_expires_at: "2026-09-01T00:00:00Z",
      status: "pending",
      mollie_customer_id: "c",
    });
    const d = deps(w, false);
    for (const run of [runExpireTiers, runTierPrewarning, runReconcilePending, runReconcileSeats])
      await run(d);
    expect(w.acc().tier).toBe("changemaker");
    expect(w.mailer.sent).toHaveLength(0);
    expect(w.mollie.calls).toHaveLength(0);
    expect(
      logLines.filter((l) => l.signal === "billing.customer_jobs_off").length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe("tier expiry", () => {
  test("a lapsed workspace account drops to free, reverts whitelabel and tells admins and billing", async () => {
    const w = world({
      org_id: null,
      workspace_id: WS1,
      tier_expires_at: "2026-09-27T09:00:00Z",
      pre_warning_sent: true,
    });
    w.store.memberships.push({
      id: "e1000000-0000-4000-8000-000000000050",
      workspace_id: WS1,
      user_id: U.external,
      role: "billing",
      source: "direct",
    });
    await runExpireTiers(deps(w));
    expect(w.acc()).toMatchObject({
      tier: "free",
      downgraded_from_tier: "changemaker",
      tier_expires_at: null,
      pre_warning_sent: false,
    });
    expect(w.acc().downgraded_at).toStartWith("2026-09-27T10:00:00");
    expect(w.store.logoCleared).toEqual([WS1]);
    expect(w.store.overCapCleared).toEqual([WS1]);
    const n = w.store.notifications;
    expect(n.map((x) => x.audience_user_id).sort()).toEqual([U.owner, U.admin, U.external].sort());
    expect(n[0]).toMatchObject({
      event_code: "TIER_EXPIRED",
      severity: "destructive",
      title: "Main tier expired",
    });
    expect(w.mailer.sent.map((m) => m.to)).toEqual([
      "admin@acme.test",
      "external@acme.test",
      "owner@acme.test",
    ]);
    const mail = w.mailer.sent[0];
    expect(mail?.subject).toBe("Main moved to free");
    expect(mail?.text).toContain("- Remove your custom logo (revert to dembrane logo)");
    expect(mail?.text).toContain(`https://dash.test/w/${WS1}/settings/billing`);

    // Idempotent: the account is on free now, so a rerun does nothing.
    await runExpireTiers(deps(w));
    expect(w.mailer.sent).toHaveLength(3);
  });

  test("an org account fans out to every covered workspace", async () => {
    const w = world({ tier_expires_at: "2026-09-01T00:00:00Z" });
    await runExpireTiers(deps(w));
    expect(w.acc().tier).toBe("free");
    expect(new Set(w.store.notifications.map((n) => n.ref_workspace_id))).toEqual(
      new Set([WS1, WS2]),
    );
  });

  test("managed accounts and unexpired tiers are left alone", async () => {
    const managed = world({ payment_mode: "offline", tier_expires_at: "2026-09-01T00:00:00Z" });
    await runExpireTiers(deps(managed));
    expect(managed.acc().tier).toBe("changemaker");
    const future = world({ tier_expires_at: "2026-12-01T00:00:00Z" });
    await runExpireTiers(deps(future));
    expect(future.acc().tier).toBe("changemaker");
  });
});

describe("pre-warning", () => {
  test("warns once, three days out, then never again for the same expiry", async () => {
    const w = world({ org_id: null, workspace_id: WS1, tier_expires_at: "2026-09-29T08:00:00Z" });
    await runTierPrewarning(deps(w));
    await runTierPrewarning(deps(w));
    expect(w.acc().pre_warning_sent).toBe(true);
    expect(w.mailer.sent.map((m) => m.subject)).toEqual([
      "Main tier expires 29 September 2026",
      "Main tier expires 29 September 2026",
    ]);
    expect(w.mailer.sent.map((m) => m.to)).toEqual(["admin@acme.test", "owner@acme.test"]);
    expect(w.store.notifications[0]).toMatchObject({
      event_code: "TIER_EXPIRING_SOON",
      severity: "action_required",
      message:
        "Your changemaker tier expires on 29 September 2026. Request an upgrade to keep full features.",
    });
  });

  test("org accounts and far expiries are skipped", async () => {
    const org = world({ tier_expires_at: "2026-09-29T08:00:00Z" });
    await runTierPrewarning(deps(org));
    expect(org.mailer.sent).toHaveLength(0);
    const far = world({ org_id: null, workspace_id: WS1, tier_expires_at: "2026-10-29T08:00:00Z" });
    await runTierPrewarning(deps(far));
    expect(far.acc().pre_warning_sent).toBe(false);
  });

  test("expiry dates read like the old emails", () => {
    expect(formatExpiryDate("2026-05-15 10:00:00+00")).toBe("15 May 2026");
    expect(formatExpiryDate(null)).toBe("soon");
  });
});

describe("reconcile schedules", () => {
  test("pending accounts whose consent cleared are activated", async () => {
    const w = world();
    await w.service.startSubscriptionCheckout(ACC, {
      tier: "changemaker",
      billingPeriod: "annual",
      redirectUrl: "x",
    });
    w.mollie.settle([...w.mollie.payments.keys()][0] as string, "paid");
    await runReconcilePending(deps(w));
    expect(w.acc().status).toBe("active");
    expect(w.mollie.callsOf("createSubscription")).toHaveLength(1);
    await runReconcilePending(deps(w));
    expect(w.mollie.callsOf("createSubscription")).toHaveLength(1);
  });

  test("one failing account does not stop the others", async () => {
    const w = world({
      status: "active",
      mollie_subscription_id: "sub_x",
      mollie_customer_id: "c",
      provisioned_seats: 1,
    });
    w.mollie.failNext("getSubscription", new Error("boom") as never);
    await runReconcileSeats(deps(w));
    expect(logLines.some((l) => l.message === "failed seat reconcile")).toBe(true);
  });
});
