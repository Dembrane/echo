import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { isUuid } from "../storage";

const { project_tag, workspace, org, directus_users, billing_account } = schema;

/** The rows the portal's project page reads besides the project itself. */
export function portalStore(db: Db) {
  return {
    /** `tags.id, tags.created_at, tags.text` with Directus's default o2m order (by id). */
    async projectTags(projectId: string) {
      if (!isUuid(projectId)) return [];
      return db
        .select({ id: project_tag.id, created_at: project_tag.created_at, text: project_tag.text })
        .from(project_tag)
        .where(eq(project_tag.project_id, projectId))
        .orderBy(asc(project_tag.id));
    },

    /** fetch_cascade_rows: the workspace (not deleted), its org (not deleted) and the legacy owner. */
    async cascade(workspaceId: string | null, ownerId: string | null) {
      let ws: typeof workspace.$inferSelect | null = null;
      let orgRow: typeof org.$inferSelect | null = null;
      if (workspaceId && isUuid(workspaceId)) {
        const [row] = await db
          .select({ ws: workspace, org })
          .from(workspace)
          .leftJoin(org, eq(org.id, workspace.org_id))
          .where(and(eq(workspace.id, workspaceId), isNull(workspace.deleted_at)))
          .limit(1);
        if (row) {
          ws = row.ws;
          orgRow = row.org && !row.org.deleted_at ? row.org : null;
        }
      }
      // The owner is read only when the workspace leaves the basis or the logo open.
      let owner: {
        whitelabel_logo: string | null;
        legal_basis: string | null;
        privacy_policy_url: string | null;
      } | null = null;
      if (ownerId && isUuid(ownerId) && !(ws?.legal_basis && ws?.logo_url)) {
        const [u] = await db
          .select({
            whitelabel_logo: directus_users.whitelabel_logo,
            legal_basis: directus_users.legal_basis,
            privacy_policy_url: directus_users.privacy_policy_url,
          })
          .from(directus_users)
          .where(eq(directus_users.id, ownerId))
          .limit(1);
        owner = u ?? null;
      }
      return { workspace: ws, org: orgRow, owner };
    },

    /** The workspace's tier through its billing account; null when either is missing. */
    async tier(billingAccountId: string | null): Promise<string | null> {
      if (!billingAccountId || !isUuid(billingAccountId)) return null;
      const [row] = await db
        .select({ tier: billing_account.tier })
        .from(billing_account)
        .where(eq(billing_account.id, billingAccountId))
        .limit(1);
      return row?.tier ?? null;
    },
  };
}
