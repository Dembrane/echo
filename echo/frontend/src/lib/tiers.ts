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
	| "pilot"
	| "pioneer"
	| "innovator"
	| "changemaker"
	| "guardian";

export const TIER_ORDER: Tier[] = [
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
];

export const TIER_TAGLINE: Record<Tier, string> = {
	pilot: "one month to try it.",
	pioneer: "for your first real engagements.",
	innovator: "privacy and data portability.",
	changemaker: "your brand, your integrations.",
	guardian: "enterprise scale.",
};

// Capacity line appended to tooltips so a new customer can answer
// "what does Pioneer mean?" without hitting the billing tab. Numbers
// mirror server/dembrane/tier_capacity.py — keep in sync.
export const TIER_CAPACITY_SHORT: Record<Tier, string> = {
	pilot: "2 seats · 10 h · one month",
	pioneer: "3 seats · 25 h/mo · €200/mo",
	innovator: "10 seats · 50 h/mo · €500/mo",
	changemaker: "20 seats · 100 h/mo · €1500/mo",
	guardian: "unlimited · custom pricing",
};

export function capacityShortFor(tier: string | null | undefined): string {
	return isTier(tier) ? TIER_CAPACITY_SHORT[tier] : "";
}

export function isTier(value: string | null | undefined): value is Tier {
	return (
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
