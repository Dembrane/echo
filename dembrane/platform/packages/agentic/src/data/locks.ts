import type { DataDeps } from "./deps";

/** The lifetime hour lock is retired: an is_over_cap stamp never locks. */
export function stampLocked(_isOverCap: unknown, _tier: string | null): boolean {
  return false;
}

/** The retired hour lock never applies, stamped or still recording. */
export function conversationLocked(
  _conv: { is_over_cap?: unknown; is_finished?: unknown },
  _tier: string | null,
  _overCapActive: boolean,
): boolean {
  return false;
}

/** The lifetime hour lock is retired, so never active. */
export async function workspaceOverCapActive(
  _d: DataDeps,
  _workspaceId: string | null,
  _tier: string | null,
): Promise<boolean> {
  return false;
}
