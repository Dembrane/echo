import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const billing = {
	"billing.account_not_found": msg({
		id: "error.billing.account_not_found",
		message: "We could not find this billing account.",
	}),
	"billing.already_subscribed": msg({
		id: "error.billing.already_subscribed",
		message: "This account already has an active subscription.",
	}),
	"billing.checkout_failed": msg({
		id: "error.billing.checkout_failed",
		message: "We could not open the payment page. Try again in a moment.",
	}),
	"billing.invoice_pdf_missing": msg({
		id: "error.billing.invoice_pdf_missing",
		message:
			"The PDF of this invoice is not ready yet. Try again in a little while.",
	}),
	"billing.no_payment_profile": msg({
		id: "error.billing.no_payment_profile",
		message: "There is no payment method to update yet. Choose a plan first.",
	}),
	"billing.payments_unavailable": msg({
		id: "error.billing.payments_unavailable",
		message:
			"Online payments are not available right now. Contact us to change your plan.",
	}),
	"billing.plan_inactive": msg({
		id: "error.billing.plan_inactive",
		message: "Your plan is not active. Reactivate it to add members.",
	}),
	"billing.request_failed": msg({
		id: "error.billing.request_failed",
		message:
			"We could not complete this billing change. Contact us and we will sort it out.",
	}),
	"billing.role_required": msg({
		id: "error.billing.role_required",
		message:
			"Only organisation owners, admins and billing members can manage billing.",
	}),
	"billing.seat_pricing_unavailable": msg({
		id: "error.billing.seat_pricing_unavailable",
		message:
			"We could not work out the seat price just now. Try again in a moment.",
	}),
	"billing.tax_id_required": msg({
		id: "error.billing.tax_id_required",
		message: "Enter at least one of your VAT, KvK or KBO numbers.",
	}),
	"billing.tier_limit": msg({
		id: "error.billing.tier_limit",
		message:
			"You have reached the limit of the free plan. Upgrade to keep going.",
	}),
	"billing.tier_not_purchasable": msg({
		id: "error.billing.tier_not_purchasable",
		message: "This plan cannot be bought online. Contact us to get it.",
	}),
	"billing.tier_required": msg({
		id: "error.billing.tier_required",
		message: "This needs the {required} plan. Upgrade to use it.",
	}),
} satisfies Messages<"billing">;
