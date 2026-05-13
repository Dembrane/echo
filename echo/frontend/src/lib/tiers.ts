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
	free: "get started.",
	changemaker: "your brand, your integrations.",
	guardian: "enterprise scale.",
	innovator: "privacy and data portability.",
	pilot: "one month to try it.",
	pioneer: "for your first real engagements.",
};

// Capacity line appended to tooltips so a new customer can answer
// "what does Pioneer mean?" without hitting the billing tab. Numbers
// mirror server/dembrane/tier_capacity.py — keep in sync.
export const TIER_CAPACITY_SHORT: Record<Tier, string> = {
	free: "1 seat · 1 h · free",
	changemaker: "20 seats · 100 h/mo · €1500/mo",
	guardian: "unlimited · custom pricing",
	innovator: "10 seats · 50 h/mo · €500/mo",
	pilot: "2 seats · 10 h · one month",
	pioneer: "3 seats · 25 h/mo · €200/mo",
};

// Per-seat overage rate (euros, monthly) when a workspace exceeds
// included seats. Free + pilot have no overage billing; Guardian is
// unlimited. Pioneer/Innovator/Changemaker bill per matrix §8. Mirror
// of seat_overage_eur in tier_capacity.py — keep in sync.
export const TIER_SEAT_OVERAGE_EUR: Record<Tier, number | null> = {
	free: null,
	changemaker: 60,
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

export function capacityShortFor(tier: string | null | undefined): string {
	return isTier(tier) ? TIER_CAPACITY_SHORT[tier] : "";
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
	return isTier(tier) ? TIER_TAGLINE[tier] : "";
}
