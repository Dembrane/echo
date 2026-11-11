import { isFreeTier } from "./free";

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextReset(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// A free account downgraded this month counts from its downgrade; a future downgrade counts from the 1st.
export function periodStart(now: Date, tier: string | null, downgradedAt: string | null): Date {
  const start = monthStart(now);
  if (!isFreeTier(tier) || !downgradedAt) return start;
  const downgraded = new Date(downgradedAt);
  if (Number.isNaN(downgraded.getTime())) return start;
  if (downgraded > start && downgraded <= now) return downgraded;
  return start;
}
