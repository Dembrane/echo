import { PaymentRequiredError } from "@dembrane/core";

/**
 * Free-tier gates the chat routes enforce. The Pilot hard block the Python routes also
 * called is not ported: its predicate (is_hard_blocked) has returned False for every tier
 * since recording was made unlimited, so it never refused anything.
 */
export const FREE_TIER_MAX_CHATS = 1;
export const FREE_TIER_MAX_CHAT_USER_TURNS = 3;
// A sample copy has its own allowance instead: this many user turns across all its chats,
// the seeded opening question included.
export const FREE_TIER_MAX_SAMPLE_USER_TURNS = 10;

// Paid tiers are not hour-capped; free is, and so is any other named tier.
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);

export const isFreeTier = (tier: string | null | undefined) => tier === "free";

/** The 402 the dashboard turns into the upgrade prompt for `limit` (chats, chat_turns). */
export function freeTierLimit(limit: string): PaymentRequiredError {
  return new PaymentRequiredError("billing.tier_limit", {
    params: { limit },
    details: { error: "FREE_TIER_LIMIT", limit, upgrade_cta_tier: "changemaker" },
  });
}

/** A conversation past the free tier's recording cap is locked out of chats and summaries. */
export function conversationIsLocked(
  conv: { is_over_cap?: unknown } | null | undefined,
  tier: string | null,
): boolean {
  if (!conv?.is_over_cap) return false;
  if (tier === null) return false;
  return !OVERAGE_TIERS.has(tier);
}
