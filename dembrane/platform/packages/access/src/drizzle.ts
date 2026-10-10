import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { AccessStore } from "./store";

const {
  workspace,
  workspace_membership,
  org_membership,
  project,
  project_membership,
  billing_account,
  support_access_request,
} = schema;

export class DrizzleAccessStore implements AccessStore {
  constructor(private readonly db: Db) {}

  async workspace(id: string) {
    const [row] = await this.db
      .select({
        id: workspace.id,
        orgId: workspace.org_id,
        visibility: workspace.visibility,
        deletedAt: workspace.deleted_at,
        settings: workspace.settings,
        tier: billing_account.tier,
      })
      .from(workspace)
      .leftJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
      .where(eq(workspace.id, id))
      .limit(1);
    if (!row) return null;
    const settings = (row.settings ?? {}) as {
      sticky_removed?: unknown;
      inherit_organisation_members?: unknown;
    };
    return {
      id: row.id,
      orgId: row.orgId,
      visibility: (row.visibility ?? "open_to_organisation") as
        | "open_to_organisation"
        | "invite_only"
        | "private",
      deleted: row.deletedAt !== null,
      stickyRemoved: stickyRemovedIds(settings.sticky_removed),
      inheritOrgMembers: settings.inherit_organisation_members === true,
      tier: row.tier ?? null,
    };
  }

  async workspaceMembership(workspaceId: string, appUserId: string, now: Date) {
    const [row] = await this.db
      .select({
        id: workspace_membership.id,
        role: workspace_membership.role,
        customPolicies: workspace_membership.custom_policies,
        source: workspace_membership.source,
      })
      .from(workspace_membership)
      .where(
        and(
          eq(workspace_membership.workspace_id, workspaceId),
          eq(workspace_membership.user_id, appUserId),
          isNull(workspace_membership.deleted_at),
          or(
            isNull(workspace_membership.expires_at),
            gt(workspace_membership.expires_at, now.toISOString()),
          ),
        ),
      )
      .limit(1);
    if (!row) return null;
    const { id, ...membership } = row;
    if (membership.source !== "staff_support") return membership;
    // An approval resolved in the last 24 hours is what lets a support session act.
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const approved = await this.db
      .select({ id: support_access_request.id })
      .from(support_access_request)
      .where(
        and(
          eq(support_access_request.membership_id, id),
          eq(support_access_request.status, "approved"),
          gt(support_access_request.resolved_at, since),
        ),
      )
      .limit(1);
    return { ...membership, supportApproved: approved.length > 0 };
  }

  async orgRole(orgId: string, appUserId: string) {
    const [row] = await this.db
      .select({ role: org_membership.role })
      .from(org_membership)
      .where(
        and(
          eq(org_membership.org_id, orgId),
          eq(org_membership.user_id, appUserId),
          isNull(org_membership.deleted_at),
        ),
      )
      .limit(1);
    return row?.role ?? null;
  }

  async project(id: string) {
    const [row] = await this.db
      .select({
        id: project.id,
        workspaceId: project.workspace_id,
        visibility: project.visibility,
        deletedAt: project.deleted_at,
        legacyOwner: project.directus_user_id,
        isSample: project.is_sample,
      })
      .from(project)
      .where(eq(project.id, id))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      visibility: row.visibility === "private" ? ("private" as const) : ("workspace" as const),
      deleted: row.deletedAt !== null,
      legacyOwnerDirectusUserId: row.legacyOwner,
      isSample: row.isSample,
    };
  }

  async hasProjectShare(projectId: string, appUserId: string) {
    const rows = await this.db
      .select({ id: project_membership.id })
      .from(project_membership)
      .where(
        and(
          eq(project_membership.project_id, projectId),
          eq(project_membership.user_id, appUserId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}

/**
 * Tombstones are stored as `{user_id, removed_at, removed_by}` objects by the old API and
 * the tenancy namespace; bare ids are accepted too. Anything else never matches a user.
 */
export function stickyRemovedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    if (typeof t === "string") return [t];
    if (t && typeof t === "object" && typeof (t as { user_id?: unknown }).user_id === "string")
      return [(t as { user_id: string }).user_id];
    return [];
  });
}
