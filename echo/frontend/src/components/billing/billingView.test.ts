import { describe, expect, it } from "vitest";

import { billingView } from "./BillingManager";

/**
 * The three account cases from R4, plus the two that used to be told apart by
 * `status`. Each case is written as the fields the server derives from `tier`,
 * `payment_mode` and the Mollie ids, so the test fails if the rule ever starts
 * reading the account `status` again.
 *
 * Field meanings, read from server/dembrane/billing_service.py:
 *   is_managed              payment_mode === "offline"
 *   has_active_subscription payment_mode === "mollie" && mollie_subscription_id
 *   has_payment_history     mollie_customer_id exists
 */
const account = (over: Partial<Parameters<typeof billingView>[0]> = {}) => ({
	has_active_subscription: false,
	has_payment_history: false,
	is_managed: false,
	...over,
});

describe("billingView", () => {
	it("gives a new free account no billing page", () => {
		// payment_mode "none", tier free, no Mollie ids.
		const v = billingView(account());
		expect(v.existingPayer).toBe(false);
		expect(v.managed).toBe(false);
		expect(v.windingDown).toBe(false);
	});

	it("gives a paying account the manage dashboard", () => {
		// payment_mode "mollie" with a live mollie_subscription_id.
		const v = billingView(
			account({ has_active_subscription: true, has_payment_history: true }),
		);
		expect(v.existingPayer).toBe(true);
		expect(v.windingDown).toBe(false);
	});

	it("keeps a cancelled customer on the manage flow", () => {
		// cancel_subscription clears mollie_subscription_id and keeps
		// mollie_customer_id, so resume and the invoice ledger stay reachable.
		const v = billingView(account({ has_payment_history: true }));
		expect(v.existingPayer).toBe(true);
		expect(v.windingDown).toBe(true);
	});

	it("gives a comped account no create path", () => {
		// grant_reverse_trial: a paid tier with payment_mode "none" and no Mollie
		// customer. `status` calls this free, which is the bug R4 exists to stop.
		const v = billingView(account());
		expect(v.existingPayer).toBe(false);
		expect(v.managed).toBe(false);
	});

	it("sends a managed account to the managed panel", () => {
		// payment_mode "offline": dembrane invoices them.
		const v = billingView(account({ is_managed: true }));
		expect(v.managed).toBe(true);
	});

	it("keeps a managed account that paid before on the managed panel", () => {
		// The component checks `managed` first, so a past Mollie customer that
		// staff moved to offline still gets the managed panel, not the dashboard.
		const v = billingView(
			account({ has_payment_history: true, is_managed: true }),
		);
		expect(v.managed).toBe(true);
	});
});
