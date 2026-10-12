import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import { isUuid } from "./storage";

const { project, workspace, billing_account } = schema;

/**
 * Free-tier conversation limits:
 * - 5 conversations per month (any duration counts as 1 conversation)
 * - Each conversation is free up to 1 hour (3600 seconds)
 * Paid tiers (innovator, changemaker, guardian) have unlimited hours/conversations.
 */
export const FREE_TIER_MAX_CONVERSATIONS_PER_MONTH = 5;
export const FREE_TIER_MAX_CONVERSATION_DURATION_SECONDS = 3600;

const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);

/** True for paid tiers (unlimited hours); false for free and anything unknown. */
export function tierAllowsOverage(tier: string | null | undefined): boolean {
  return typeof tier === "string" && OVERAGE_TIERS.has(tier);
}

/**
 * The finish-time stamp: for free tier, a conversation is over cap if:
 * 1. The workspace already reached 5 conversations in the calendar month prior to this one, OR
 * 2. This conversation's duration exceeded the 1 hour (3600s) free conversation limit.
 * Paid tiers and unknown tiers never lock.
 */
export function computeIsOverCap(
  tier: string,
  priorConversationsInMonth: number,
  conversationDurationSeconds: number,
): boolean {
  if (tierAllowsOverage(tier)) return false;
  if (tier !== "free") return false;
  if (priorConversationsInMonth >= FREE_TIER_MAX_CONVERSATIONS_PER_MONTH) return true;
  if (conversationDurationSeconds > FREE_TIER_MAX_CONVERSATION_DURATION_SECONDS) return true;
  return false;
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
