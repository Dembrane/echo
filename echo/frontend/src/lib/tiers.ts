import { t } from "@lingui/core/macro";

/**
 * Tier taglines (matrix v1.1 §1).
 *
 * Every surface that shows a tier name must pair it with a tagline.
 * Kept in sync with server/dembrane/tier_capacity.py — if copy changes,
 * update both sides. The two-source pattern is intentional: the backend
 * uses taglines in email templates; the frontend uses them in UI; they
 * don't need a round-trip.
 */

export type Tier =
	| "free"
	| "pilot"
	| "pioneer"
	| "innovator"
	| "changemaker"
	| "guardian";

export const TIER_ORDER: Tier[] = [
	"free",
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
];

export const TIER_TAGLINE: Record<Tier, string> = {
	changemaker: "For governments and enterprises",
	free: "get started.",
	guardian: "For highest-compliance environments",
	innovator: "For organisations with ongoing participation",
	pilot: "one month to try it.",
	pioneer: "For small teams and single projects",
};

// Capacity line appended to tooltips so a new customer can answer
// "what does Pioneer mean?" without hitting the billing tab. Numbers
// mirror server/dembrane/tier_capacity.py — keep in sync. Annual-billing
// per-month prices (matches the matrix's anchor cadence).
export const TIER_CAPACITY_SHORT: Record<Tier, string> = {
	changemaker: "20 seats · 100 h/mo · €1500/mo",
	free: "1 seat · 1 h · free",
	guardian: "unlimited · €5000/mo",
	innovator: "10 seats · 50 h/mo · €500/mo",
	pilot: "2 seats · 10 h · €349 one-time",
	pioneer: "3 seats · 25 h/mo · €200/mo",
};

// Per-seat overage rate (euros, monthly) when a workspace exceeds
// included seats. Free + pilot have no overage billing; Guardian is
// unlimited. Pioneer/Innovator/Changemaker bill per matrix §8. Mirror
// of seat_overage_eur in tier_capacity.py — keep in sync.
export const TIER_SEAT_OVERAGE_EUR: Record<Tier, number | null> = {
	changemaker: 60,
	free: null,
	guardian: null,
	innovator: 30,
	pilot: null,
	pioneer: 25,
};

export function seatOverageRateFor(
	tier: string | null | undefined,
): number | null {
	return isTier(tier) ? TIER_SEAT_OVERAGE_EUR[tier] : null;
}

export const TIER_BEST_FOR: Record<Tier, string> = {
	changemaker: "Best for large organisations with complex needs.",
	free: "",
	guardian: "Sovereign infrastructure and full set up.",
	innovator: "Best for organisations running regular engagements.",
	pilot: "",
	pioneer: "Best for smaller teams running individual projects.",
};

export function tierBestFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`Best for large organisations with complex needs.`,
		free: "",
		guardian: t`Sovereign infrastructure and full set up.`,
		innovator: t`Best for organisations running regular engagements.`,
		pilot: "",
		pioneer: t`Best for smaller teams running individual projects.`,
	};
	return map[tier];
}

export function capacityShortFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`20 seats · 100 h/mo · €1500/mo`,
		free: t`1 seat · 1 h · free`,
		guardian: t`unlimited · €5000/mo`,
		innovator: t`10 seats · 50 h/mo · €500/mo`,
		pilot: t`2 seats · 10 h · €349 one-time`,
		pioneer: t`3 seats · 25 h/mo · €200/mo`,
	};
	return map[tier];
}

export function isTier(value: string | null | undefined): value is Tier {
	return (
		value === "free" ||
		value === "pilot" ||
		value === "pioneer" ||
		value === "innovator" ||
		value === "changemaker" ||
		value === "guardian"
	);
}

export function taglineFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`For governments and enterprises`,
		free: t`get started.`,
		guardian: t`For highest-compliance environments`,
		innovator: t`For organisations with ongoing participation`,
		pilot: t`one month to try it.`,
		pioneer: t`For small teams and single projects`,
	};
	return map[tier];
}

export const TIER_BADGE_COLOR: Record<Tier, string> = {
	changemaker: "grape",
	free: "gray",
	guardian: "orange",
	innovator: "violet",
	pilot: "gray",
	pioneer: "blue",
};

export type BillingPeriod = "annual" | "monthly";

export interface AnnualPricing {
	per_month_eur: number;
	total_per_year_eur: number;
}

export interface MonthlyPricing {
	per_month_eur: number;
}

export interface OneTimePricing {
	amount_eur: number;
}

export interface TierPricing {
	annual_billing?: AnnualPricing | null;
	monthly_billing?: MonthlyPricing | null;
	one_time?: OneTimePricing | null;
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
 * Resolve the active-cadence pricing slot for a tier capacity.
 *
 * Returns the slot the UI should render in for the active billing period,
 * or `null` when the tier has no displayable price (free).
 *
 * - Annual selected, pioneer+ → `annual_billing`
 * - Monthly selected, pioneer+ → `monthly_billing`
 * - Pilot → `one_time` (ignores billing period — toggle does not move pilot)
 * - Free → null
 */
export function pricingForBillingPeriod(
	cap: TierCapacity,
	period: BillingPeriod,
):
	| { kind: "annual"; per_month_eur: number; total_per_year_eur: number }
	| { kind: "monthly"; per_month_eur: number }
	| { kind: "one_time"; amount_eur: number }
	| null {
	const p = cap.pricing;
	if (!p) return null;
	if (p.one_time) {
		return { amount_eur: p.one_time.amount_eur, kind: "one_time" };
	}
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
