import type { Row } from "../storage";

/** Paid tiers bill hours instead of capping them (tier_capacity.OVERAGE_TIERS). */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);

export function tierAllowsOverage(tier: string): boolean {
  return OVERAGE_TIERS.has(tier);
}

/** is_conversation_locked: the finish-time stamp plus a tier that is still hour-capped. */
export function stampLocked(conv: Row, tier: string | null): boolean {
  if (!conv.is_over_cap) return false;
  if (tier === null) return false;
  return !tierAllowsOverage(tier);
}

/** workspace_over_cap_active: the lifetime hour lock is retired, so never active. */
export async function overCapActive(
  _workspaceId: string | null,
  _tier: string | null,
  _seconds: (workspaceId: string) => Promise<number>,
): Promise<boolean> {
  return false;
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
