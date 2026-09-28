import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import { isUuid } from "./storage";

const { project, workspace, billing_account } = schema;

/**
 * The hour-cap rules of tier_capacity.py (ADR 0001) that conversations need: paid tiers
 * have unlimited hours and never lock; free has a one hour lifetime cap. Unknown tiers
 * (legacy pilot, pioneer) have no capacity row and are never capped.
 */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
const INCLUDED_HOURS: Readonly<Record<string, number | null>> = {
  free: 1,
  innovator: null,
  changemaker: null,
  guardian: null,
};

/** True for paid tiers (unlimited hours); false for free and anything unknown. */
export function tierAllowsOverage(tier: string | null | undefined): boolean {
  return typeof tier === "string" && OVERAGE_TIERS.has(tier);
}

/**
 * The finish-time stamp: over cap when the tier is capped and the hours recorded before
 * this conversation already reached the cap, so a conversation that started under the
 * cap stays unlocked even if its own recording crossed it.
 */
export function computeIsOverCap(
  tier: string,
  workspaceAudioHours: number,
  conversationHours: number,
): boolean {
  if (tierAllowsOverage(tier)) return false;
  const included = INCLUDED_HOURS[tier];
  if (included === undefined || included === null) return false;
  return workspaceAudioHours - conversationHours >= included;
}

/** The live lock: the stamp says over cap and the current tier is hour-capped. */
export function isConversationLocked(
  conversation: { readonly is_over_cap?: boolean | null },
  tier: string | null,
): boolean {
  if (!conversation.is_over_cap) return false;
  if (tier === null) return false;
  return !tierAllowsOverage(tier);
}

/**
 * A project's tier through its workspace's billing account; null when the project, its
 * workspace or the account is missing (legacy projects have no workspace). Soft-deleted
 * rows still resolve, as the Python's get_item did.
 */
export async function resolveProjectTier(db: Db, projectId: string): Promise<string | null> {
  if (!isUuid(projectId)) return null;
  const [row] = await db
    .select({ tier: billing_account.tier, workspaceId: project.workspace_id })
    .from(project)
    .leftJoin(workspace, eq(workspace.id, project.workspace_id))
    .leftJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
    .where(eq(project.id, projectId))
    .limit(1);
  return row?.workspaceId ? (row.tier ?? null) : null;
}
