// A sample copy has its own allowance instead: this many user turns across all its chats,
// the seeded opening question included.
export const FREE_TIER_MAX_SAMPLE_USER_TURNS = 10;

/** The lifetime hour lock is retired: no conversation is locked out of chats or summaries. */
export function conversationIsLocked(
  _conv: { is_over_cap?: unknown } | null | undefined,
  _tier: string | null,
): boolean {
  return false;
}
