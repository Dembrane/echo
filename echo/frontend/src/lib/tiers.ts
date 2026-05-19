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
	changemaker: "your brand, your integrations.",
	free: "get started.",
	guardian: "enterprise scale.",
	innovator: "privacy and data portability.",
	pilot: "one month to try it.",
	pioneer: "for your first real engagements.",
};

// Capacity line appended to tooltips so a new customer can answer
// "what does Pioneer mean?" without hitting the billing tab. Numbers
// mirror server/dembrane/tier_capacity.py — keep in sync.
export const TIER_CAPACITY_SHORT: Record<Tier, string> = {
	changemaker: "20 seats · 100 h/mo · €1500/mo",
	free: "1 seat · 1 h · free",
	guardian: "unlimited · custom pricing",
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
		guardian: t`unlimited · custom pricing`,
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
		changemaker: t`your brand, your integrations.`,
		free: t`get started.`,
		guardian: t`enterprise scale.`,
		innovator: t`privacy and data portability.`,
		pilot: t`one month to try it.`,
		pioneer: t`for your first real engagements.`,
	};
	return map[tier];
}

export const TIER_BADGE_COLOR: Record<Tier, string> = {
	free: "gray",
	pilot: "gray",
	pioneer: "blue",
	innovator: "violet",
	changemaker: "grape",
	guardian: "orange",
};

export interface TierCapacity {
	tier: string;
	tagline: string;
	price_eur_monthly: number | null;
	price_note: string;
	duration: string;
	included_seats: number | null;
	seat_overage_eur: number | null;
	included_hours: number | null;
	hour_overage_eur: number | null;
	hard_block_on_hours: boolean;
	training_included: string;
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
