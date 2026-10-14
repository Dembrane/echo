import { type DataDeps, sqlOf } from "./deps";

/**
 * The free tier's recording cap, shared by every read that returns conversation text: a
 * locked conversation keeps its row but loses its summary and transcript, so hitting the
 * cap never leaks content past the upgrade prompt. Paid tiers and legacy projects (no
 * tier) never lock.
 */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
/** Tiers with an hour cap and how many hours it allows. */
const INCLUDED_HOURS: Record<string, number> = { free: 1 };

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
 * Whether the workspace is past its lifetime hour cap now. Counts every conversation of
 * every project the workspace ever held, deleted ones too: deleting audio keeps its
 * billable duration. A sample copy (project.is_sample) holds no one's audio and is left out.
 */
export async function workspaceOverCapActive(
  d: DataDeps,
  workspaceId: string | null,
  tier: string | null,
): Promise<boolean> {
  if (!workspaceId || tier === null || OVERAGE_TIERS.has(tier)) return false;
  const included = INCLUDED_HOURS[tier];
  if (included === undefined) return false;
  const [r] = await sqlOf(d)`
    select coalesce(sum(c.duration), 0)::float8 as seconds
    from conversation c join project p on p.id = c.project_id
    where p.workspace_id = ${workspaceId} and not p.is_sample`;
  return Number(r?.seconds ?? 0) / 3600 >= included;
}
