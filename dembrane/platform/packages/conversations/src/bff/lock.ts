import type { Row } from "../storage";

/** Paid tiers bill hours instead of capping them (tier_capacity.OVERAGE_TIERS). */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
export const FREE_TIER_MAX_CONVERSATIONS_PER_MONTH = 5;

export function tierAllowsOverage(tier: string): boolean {
  return OVERAGE_TIERS.has(tier);
}

/** is_conversation_locked: the finish-time stamp plus a tier that is still hour-capped. */
export function stampLocked(conv: Row, tier: string | null): boolean {
  if (!conv.is_over_cap) return false;
  if (tier === null) return false;
  return !tierAllowsOverage(tier);
}

/**
 * workspace_over_cap_active: whether a free workspace is past its monthly conversation
 * cap right now, which also locks conversations still recording. Paid and legacy tiers never cap.
 */
export async function overCapActive(
  workspaceId: string | null,
  tier: string | null,
  countMonthly: (workspaceId: string, startOfMonthIso: string) => Promise<number>,
  now: Date = new Date(),
): Promise<boolean> {
  if (!workspaceId || tier === null || tierAllowsOverage(tier) || tier !== "free") return false;
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return (await countMonthly(workspaceId, startOfMonth)) >= FREE_TIER_MAX_CONVERSATIONS_PER_MONTH;
}

/** (locked, lock_reason) for one conversation, shared by list, detail and chunk reads. */
export function conversationLock(conv: Row, tier: string | null, active: boolean) {
  if (stampLocked(conv, tier)) return { locked: true, reason: "hours_cap" as const };
  if (active && !conv.is_finished) return { locked: true, reason: "hours_cap" as const };
  return { locked: false, reason: null };
}

export function scrubChunk(chunk: Row): Row {
  chunk.transcript = null;
  chunk.transcript_locked = true;
  return chunk;
}

/**
 * _enrich_conversation: derived `locked` and `lock_reason`, gated text removed from a
 * locked row (summary, merged transcript, embedded chunk transcripts), and
 * the raw stamp dropped so clients read the decision, not its input.
 */
export function enrich(conv: Row, tier: string | null, active: boolean): Row {
  const { locked, reason } = conversationLock(conv, tier, active);
  conv.locked = locked;
  conv.lock_reason = reason;
  if (locked) {
    conv.summary = null;
    conv.summary_locked = true;
    if ("merged_transcript" in conv) conv.merged_transcript = null;
    if (Array.isArray(conv.chunks))
      for (const ch of conv.chunks) if (ch && typeof ch === "object") scrubChunk(ch as Row);
  }
  delete conv.is_over_cap;
  return conv;
}
