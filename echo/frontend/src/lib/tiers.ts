import { t } from "@lingui/core/macro";

/**
 * Tier copy + helpers (ADR 0005, per-seat tiers).
 *
 * Kept in sync with server/dembrane/tier_capacity.py. Free is retained in the
 * type as the internal baseline (default workspace, downgrade target) and for
 * rendering an existing workspace's badge, but it is HIDDEN from customer-facing
 * plan selection for now — see VISIBLE_TIERS.
 */

export type Tier = "free" | "innovator" | "changemaker" | "guardian";

// Lowest -> highest. Free stays for ordering/comparison (meetsTier).
export const TIER_ORDER: Tier[] = [
	"free",
	"innovator",
	"changemaker",
	"guardian",
];

// Customer-facing, selectable plans (pricing cards, plan picker). Free is
// hidden for now; re-add it here to expose it again. Innovator/Guardian are
// "coming soon" (gated on the MCP / sovereign stack) but still shown.
export const VISIBLE_TIERS: Tier[] = [
	// "free",  // hidden for now
	"innovator",
	"changemaker",
	"guardian",
];

// Tiers shown but not yet purchasable: Innovator waits on the MCP, Guardian on
// the EU-sovereign stack. They render with a "Coming soon" badge and can't be
// selected/checked out. Changemaker is the only sellable plan today. Single
// source of truth — used by the pricing cards, plan picker, and checkout.
export const COMING_SOON_TIERS: Tier[] = ["innovator", "guardian"];

export function isComingSoon(tier: string | null | undefined): boolean {
	return !!tier && (COMING_SOON_TIERS as string[]).includes(tier);
}

// The plan we sell today + default selection.
export const SELLABLE_TIER: Tier = "changemaker";

// Annual is the anchor price; monthly cadence is surcharged by this percent
// ("X% off when you pay annually"). Single knob — mirrors
// MONTHLY_BILLING_PREMIUM_PCT in server/dembrane/tier_capacity.py. Change both
// together. Drives the toggle badge + the offline price fallback.
export const MONTHLY_BILLING_PREMIUM_PCT = 20;

export const TIER_TAGLINE: Record<Tier, string> = {
	changemaker: "Built-in analysis, audit logs, white labeling",
	free: "get started.",
	guardian: "EU-sovereign, CLOUD Act safe",
	innovator: "Bring your own LLM",
};

// Per-seat capacity one-liners. Mirror server/dembrane/tier_capacity.py.
export const TIER_CAPACITY_SHORT: Record<Tier, string> = {
	changemaker: "€75 / seat / month",
	free: "1 seat · 1 h",
	guardian: "€150 / seat / month",
	innovator: "€20 / seat / month",
};

export function capacityShortFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`€75 / seat / month`,
		free: t`1 seat · 1 h`,
		guardian: t`€150 / seat / month`,
		innovator: t`€20 / seat / month`,
	};
	return map[tier];
}

export const TIER_BEST_FOR: Record<Tier, string> = {
	changemaker: "Built-in EU analysis, audit logs, and white labeling.",
	free: "",
	guardian: "EU-sovereign stack for the highest-compliance environments.",
	innovator: "Bring your own LLM via the MCP. Unlimited hours.",
};

export function tierBestFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`Built-in EU analysis, audit logs, and white labeling.`,
		free: "",
		guardian: t`EU-sovereign stack for the highest-compliance environments.`,
		innovator: t`Bring your own LLM via the MCP. Unlimited hours.`,
	};
	return map[tier];
}

export function isTier(value: string | null | undefined): value is Tier {
	return (
		value === "free" ||
		value === "innovator" ||
		value === "changemaker" ||
		value === "guardian"
	);
}

export function taglineFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`Built-in analysis, audit logs, white labeling`,
		free: t`get started.`,
		guardian: t`EU-sovereign, CLOUD Act safe`,
		innovator: t`Bring your own LLM`,
	};
	return map[tier];
}

export const TIER_BADGE_COLOR: Record<Tier, string> = {
	changemaker: "grape",
	free: "gray",
	guardian: "orange",
	innovator: "violet",
};

export type BillingPeriod = "annual" | "monthly";

export interface AnnualPricing {
	per_month_eur: number;
	total_per_year_eur: number;
}

export interface MonthlyPricing {
	per_month_eur: number;
}

export interface TierPricing {
	annual_billing?: AnnualPricing | null;
	monthly_billing?: MonthlyPricing | null;
}

export interface TierCapacity {
	tier: string;
	tagline: string;
	pricing: TierPricing | null;
	billing_period_applicable: boolean;
	duration: string;
	included_seats: number | null;
	seat_overage_eur: number | null;
	included_hours: number | null;
	hour_overage_eur: number | null;
	hard_block_on_hours: boolean;
	training_included: string;
}

/**
 * Resolve the active-cadence pricing slot for a tier capacity (per seat).
 *
 * - Annual selected -> `annual_billing`
 * - Monthly selected -> `monthly_billing`
 * - Free -> null (no displayable price)
 */
export function pricingForBillingPeriod(
	cap: TierCapacity,
	period: BillingPeriod,
):
	| { kind: "annual"; per_month_eur: number; total_per_year_eur: number }
	| { kind: "monthly"; per_month_eur: number }
	| null {
	const p = cap.pricing;
	if (!p) return null;
	if (period === "monthly" && p.monthly_billing) {
		return {
			kind: "monthly",
			per_month_eur: p.monthly_billing.per_month_eur,
		};
	}
	if (p.annual_billing) {
		return {
			kind: "annual",
			per_month_eur: p.annual_billing.per_month_eur,
			total_per_year_eur: p.annual_billing.total_per_year_eur,
		};
	}
	return null;
}

export async function fetchTierCapacities(
	apiBaseUrl: string,
): Promise<TierCapacity[]> {
	const res = await fetch(`${apiBaseUrl}/v2/workspaces/tier-capacities`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}
