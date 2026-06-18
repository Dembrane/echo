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

// Innovator and Guardian are shown with a "Coming soon" badge, not
// selectable/checkout-able. Changemaker is live. Single source of truth:
// used by the pricing cards, plan picker, and checkout.
export const COMING_SOON_TIERS: Tier[] = ["innovator", "guardian"];

export function isComingSoon(tier: string | null | undefined): boolean {
	return !!tier && (COMING_SOON_TIERS as string[]).includes(tier);
}

// Tiers a customer can actually buy right now: visible minus coming-soon.
// Single source for "how many plans are sellable" -- drives the Popular badge
// (ISSUE-011: a "Popular" tag on the sole buyable option reads oddly, so it is
// hidden while exactly one tier is purchasable and auto-restores at >=2).
export const PURCHASABLE_TIERS: Tier[] = VISIBLE_TIERS.filter(
	(tier) => !isComingSoon(tier),
);

// True only when there are at least two tiers a customer can actually buy.
// Drives "Change plan": with a single purchasable tier (today, only
// Changemaker) there is nothing to change to, so the button is hidden; it
// auto-restores the moment a second tier goes live (mirrors backend
// PURCHASABLE_TIERS in server/dembrane/tier_capacity.py).
export function hasMultiplePurchasableTiers(): boolean {
	return PURCHASABLE_TIERS.length >= 2;
}

// Recently launched: render a "New" badge. None currently.
export const NEW_TIERS: Tier[] = [];

export function isNewTier(tier: string | null | undefined): boolean {
	return !!tier && (NEW_TIERS as string[]).includes(tier);
}

export type TierBadgeKind = "coming-soon" | "new" | "popular" | null;

// One precedence for every tier surface (pricing cards + capacity matrix):
// coming-soon wins, then new, then the single popular tier. Keeps the badge
// consistent so a "coming soon" tier can never also read as "popular". Pass an
// explicit `popularTier` to override the default (SELLABLE_TIER).
export function resolveTierBadge(
	tier: string | null | undefined,
	opts?: { popularTier?: string | null },
): TierBadgeKind {
	if (isComingSoon(tier)) return "coming-soon";
	if (isNewTier(tier)) return "new";
	const popular =
		opts && "popularTier" in opts ? opts.popularTier : SELLABLE_TIER;
	if (popular && tier === popular) return "popular";
	return null;
}

// Default selection in the plan picker (also carries the POPULAR badge).
export const SELLABLE_TIER: Tier = "changemaker";

// Annual is the anchor price; monthly cadence is surcharged by this percent
// ("X% off when you pay annually"). Single knob — mirrors
// MONTHLY_BILLING_PREMIUM_PCT in server/dembrane/tier_capacity.py. Change both
// together. Drives the toggle badge + the offline price fallback.
export const MONTHLY_BILLING_PREMIUM_PCT = 20;

// Single source for the offline/fallback per-seat annual price (EUR/seat/mo).
// Mirrors price_eur_monthly in server/dembrane/tier_capacity.py; the live price
// comes from the API, this only backstops first paint before the call returns.
export const TIER_FALLBACK_PRICE_EUR: Record<Tier, number | null> = {
	changemaker: 75,
	free: null,
	guardian: 150,
	innovator: 20,
};

// One-liner capacity summary. The prices here are translatable display copy
// (kept literal so the i18n catalogs stay stable); the numeric source of truth
// for computation is TIER_FALLBACK_PRICE_EUR + the live API.
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

export function tierBestFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`EU-hosted analysis, audit logs, and white labeling.`,
		free: "",
		guardian: t`Cloud Act safe. EU-sovereign stack for the strictest compliance.`,
		innovator: t`Bring your own LLM via the MCP.`,
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
		changemaker: t`EU hosted LLMs included`,
		free: t`get started.`,
		guardian: t`Cloud Act Safe`,
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

// Shared display formatters. Single source so the pricing cards and the
// capacity matrix render the same numbers identically.
export function formatTierPrice(
	cap: TierCapacity,
	billingPeriod: BillingPeriod,
): string {
	const resolved = pricingForBillingPeriod(cap, billingPeriod);
	if (!resolved) return t`Free`;
	return `€${resolved.per_month_eur.toLocaleString("en-IE")}`;
}

export function formatTierPricePeriod(
	cap: TierCapacity,
	billingPeriod: BillingPeriod,
): string {
	const resolved = pricingForBillingPeriod(cap, billingPeriod);
	if (!resolved) return "";
	if (resolved.kind === "annual") return t`/seat/mo · billed annually`;
	return t`/seat/mo · billed monthly`;
}

export function formatTierSeats(cap: TierCapacity): string {
	if (cap.included_seats == null) return "∞";
	return String(cap.included_seats);
}

export function formatTierHours(cap: TierCapacity): string {
	if (cap.included_hours == null) return "∞";
	return String(cap.included_hours);
}

export function formatTierSeatOverage(cap: TierCapacity): string {
	if (cap.seat_overage_eur == null) return "—";
	return t`+€${cap.seat_overage_eur}/seat`;
}

export function formatTierHourOverage(cap: TierCapacity): string {
	if (cap.hard_block_on_hours) return "€0";
	if (cap.hour_overage_eur == null) return "—";
	return t`€${cap.hour_overage_eur}/h`;
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
