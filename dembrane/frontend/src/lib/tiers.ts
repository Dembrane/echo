import { t } from "@lingui/core/macro";

/**
 * Tier copy + helpers (per-seat tiers).
 *
 * Kept in sync with server/dembrane/tier_capacity.py.
 *
 * TIER_ORDER is the ONE tier list (R26). There used to be three: this file's
 * VISIBLE_TIERS, which nothing read, a copy inside the price cards, and a
 * third derived in FeatureGate. A list that looks authoritative and is dead
 * code is worse than no list, because the next person edits it and sees no
 * effect. The price cards are gone now, and FeatureGate reads this one.
 * Everything else here is a derivation of TIER_ORDER.
 */

export type Tier = "free" | "innovator" | "changemaker" | "guardian";

// Lowest -> highest. Free stays for ordering/comparison (meetsTier).
export const TIER_ORDER: Tier[] = [
	"free",
	"innovator",
	"changemaker",
	"guardian",
];

// Innovator and Guardian are shown with a "Coming soon" badge, not
// selectable/checkout-able. Changemaker is live. Single source of truth:
// used by the pricing cards and the staff tier grant.
export const COMING_SOON_TIERS: Tier[] = ["innovator", "guardian"];

export function isComingSoon(tier: string | null | undefined): boolean {
	return !!tier && (COMING_SOON_TIERS as string[]).includes(tier);
}

// Tiers a customer can hold on a paid plan right now: the order minus free and
// minus coming-soon. Drives the staff tier grant, and the Popular badge
// (ISSUE-011: a "Popular" tag on the sole buyable option reads oddly, so it is
// hidden while exactly one tier is purchasable and auto-restores at >=2).
export const PURCHASABLE_TIERS: Tier[] = TIER_ORDER.filter(
	(tier) => tier !== "free" && !isComingSoon(tier),
);

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

// The one paid tier that is live today. Carries the POPULAR badge, and is the
// tier the feature gates and badges compare against. The plan picker that used
// to default to it is gone.
export const SELLABLE_TIER: Tier = "changemaker";

// MONTHLY_BILLING_PREMIUM_PCT and TIER_FALLBACK_PRICE_EUR are gone with the
// price cards and the billing period toggle. Nothing in the app should hold a
// price of its own: the live figure comes from the API, and the upgrade path
// shows no price at all now. The server keeps the numbers in
// tier_capacity.py.

// One-liner capacity summary. The prices here are translatable display copy,
// and the live numbers come from the API.
export function capacityShortFor(tier: string | null | undefined): string {
	if (!isTier(tier)) return "";
	const map: Record<Tier, string> = {
		changemaker: t`€75 / seat / month`,
		free: t`Monthly free allowance`,
		guardian: t`€150 / seat / month`,
		innovator: t`€20 / seat / month`,
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
