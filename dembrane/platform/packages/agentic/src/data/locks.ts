import type { DataDeps } from "./deps";

/**
 * The free tier's recording cap, shared by every read that returns conversation text: a
 * locked conversation keeps its row but loses its summary and transcript, so hitting the
 * cap never leaks content past the upgrade prompt. Paid tiers and legacy projects (no
 * tier) never lock.
 */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);

/** The finish-time stamp decides for finished conversations. */
export function stampLocked(isOverCap: unknown, tier: string | null): boolean {
  if (!isOverCap) return false;
  if (tier === null) return false;
  return !OVERAGE_TIERS.has(tier);
}

/** The conversation lock: the stamp, or the live cap for one still recording. */
export function conversationLocked(
  conv: { is_over_cap?: unknown; is_finished?: unknown },
  tier: string | null,
  overCapActive: boolean,
): boolean {
  if (stampLocked(conv.is_over_cap, tier)) return true;
  return overCapActive && !conv.is_finished;
}

/** The lifetime hour lock is retired, so never active. */
export async function workspaceOverCapActive(
  _d: DataDeps,
  _workspaceId: string | null,
  _tier: string | null,
): Promise<boolean> {
  return false;
}
