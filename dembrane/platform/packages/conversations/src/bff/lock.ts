import type { Row } from "../storage";

/** workspace_over_cap_active: the lifetime hour lock is retired, so never active. */
export async function overCapActive(
  _workspaceId: string | null,
  _tier: string | null,
  _seconds: (workspaceId: string) => Promise<number>,
): Promise<boolean> {
  return false;
}

/** (locked, lock_reason) for one conversation; the retired hour lock never applies. */
export function conversationLock(
  _conv: Row,
  _tier: string | null,
  _active: boolean,
): { locked: boolean; reason: "hours_cap" | null } {
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
