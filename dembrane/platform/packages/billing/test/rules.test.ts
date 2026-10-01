import { expect, test } from "bun:test";
import {
  accountBlocksSeatAdd,
  accountRow,
  billingAccountBlocksNewWorkspace,
  hasLiveMollieSubscription,
  sameBillingContext,
} from "../src";

test("seats are added only on an active plan", () => {
  expect(accountBlocksSeatAdd(null)).toBeNull();
  expect(accountBlocksSeatAdd({ status: "active" })).toBeNull();
  expect(accountBlocksSeatAdd({ status: "past_due" })).toBe("reactivate_required");
  expect(accountBlocksSeatAdd({ status: "canceled" })).toBe("reactivate_required");
  expect(accountBlocksSeatAdd({ status: "pending" })).toBeNull();
});

test("new workspaces need a live, uncanceled account", () => {
  expect(billingAccountBlocksNewWorkspace(null)).toBe("organisation has no valid billing account");
  expect(billingAccountBlocksNewWorkspace({ deleted_at: "x", status: "active" })).not.toBeNull();
  expect(billingAccountBlocksNewWorkspace({ deleted_at: null, status: "canceled" })).toContain(
    "canceled",
  );
  expect(billingAccountBlocksNewWorkspace({ deleted_at: null, status: "past_due" })).toBeNull();
});

test("billing contexts: org accounts share one, a separately billed workspace is its own", () => {
  const org1 = accountRow({ id: "a1", org_id: "o1" });
  const org1b = accountRow({ id: "a2", org_id: "o1" });
  const ws = accountRow({ id: "a3", workspace_id: "w1" });
  expect(sameBillingContext(org1, org1b)).toBe(true);
  expect(sameBillingContext(org1, ws)).toBe(false);
  expect(sameBillingContext(ws, ws)).toBe(true);
  expect(sameBillingContext(null, null)).toBe(false);
  expect(
    hasLiveMollieSubscription(
      accountRow({ id: "x", payment_mode: "mollie", mollie_subscription_id: "s" }),
    ),
  ).toBe(true);
  expect(
    hasLiveMollieSubscription(
      accountRow({ id: "x", payment_mode: "offline", mollie_subscription_id: "s" }),
    ),
  ).toBe(false);
});
