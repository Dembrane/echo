// A sample copy has its own allowance instead: this many user turns across all its chats,
// the seeded opening question included.
export const FREE_TIER_MAX_SAMPLE_USER_TURNS = 10;

// Paid tiers are not hour-capped; free is, and so is any other named tier.
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);

/** A conversation past the free tier's recording cap is locked out of chats and summaries. */
export function conversationIsLocked(
  conv: { is_over_cap?: unknown } | null | undefined,
  tier: string | null,
): boolean {
  if (!conv?.is_over_cap) return false;
  if (tier === null) return false;
  return !OVERAGE_TIERS.has(tier);
}
