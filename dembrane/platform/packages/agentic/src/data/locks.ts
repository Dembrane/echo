import { type DataDeps, sqlOf } from "./deps";

/**
 * The free tier's recording cap, shared by every read that returns conversation text: a
 * locked conversation keeps its row but loses its summary and transcript, so hitting the
 * cap never leaks content past the upgrade prompt. Paid tiers and legacy projects (no
 * tier) never lock.
 */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
export const FREE_TIER_MAX_CONVERSATIONS_PER_MONTH = 5;

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

/**
 * Whether the workspace is past its monthly conversation cap now (5 conversations/month for free).
 * Counts live conversations created this month.
 */
export async function workspaceOverCapActive(
  d: DataDeps,
  workspaceId: string | null,
  tier: string | null,
): Promise<boolean> {
  if (!workspaceId || tier === null || OVERAGE_TIERS.has(tier) || tier !== "free") return false;
  const [r] = await sqlOf(d)`
    select count(c.id)::int as n
    from conversation c join project p on p.id = c.project_id
    where p.workspace_id = ${workspaceId}
      and not p.is_sample
      and c.deleted_at is null
      and c.created_at >= date_trunc('month', now() at time zone 'UTC')`;
  return Number(r?.n ?? 0) >= FREE_TIER_MAX_CONVERSATIONS_PER_MONTH;
}
