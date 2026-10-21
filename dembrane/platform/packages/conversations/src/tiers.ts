import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import { isUuid } from "./storage";

const { project, workspace, billing_account } = schema;

/** The lifetime hour lock is retired: no conversation is locked, whatever its stamp says. */
export function isConversationLocked(
  _conversation: { readonly is_over_cap?: boolean | null },
  _tier: string | null,
): boolean {
  return false;
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
