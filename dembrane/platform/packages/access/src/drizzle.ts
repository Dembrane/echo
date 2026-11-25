import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AccessStore, WorkspaceRow } from "./store";

const {
  workspace,
  workspace_membership,
  org_membership,
  project,
  project_membership,
  billing_account,
  support_access_request,
} = schema;

type Conn = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long an approved support request lets its visit make changes. */
const SUPPORT_APPROVAL_MS = 86_400_000;

/**
 * Ends the approvals a support visit rests on. A visit row is reused when staff come back,
 * so every place that ends a visit calls this: a rejoin starts read only, as a new visit.
 */
export async function endSupportApprovals(db: Conn, membershipId: string) {
  await db
    .update(support_access_request)
    .set({ membership_id: null })
    .where(eq(support_access_request.membership_id, membershipId));
}

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
    return {
      id: row.id,
      orgId: row.orgId,
      ...workspaceReach(row),
      deleted: row.deletedAt !== null,
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
    // An approval resolved in the last 24 hours is what lets a support session act, until
    // 24 hours after it was resolved.
    const since = new Date(now.getTime() - SUPPORT_APPROVAL_MS).toISOString();
    const [approval] = await this.db
      .select({ resolvedAt: support_access_request.resolved_at })
      .from(support_access_request)
      .where(
        and(
          eq(support_access_request.membership_id, id),
          eq(support_access_request.status, "approved"),
          gt(support_access_request.resolved_at, since),
        ),
      )
      .orderBy(desc(support_access_request.resolved_at))
      .limit(1);
    const until = approval?.resolvedAt
      ? new Date(new Date(approval.resolvedAt).getTime() + SUPPORT_APPROVAL_MS).toISOString()
      : null;
    return { ...membership, supportApproved: until !== null, supportChangeUntil: until };
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
 * What a workspace row says about who derives access to it from the organisation: its
 * visibility, the members removed for good, whether plain members join, and whether it is
 * held back for a demo. Read the same way wherever a rule must count exactly what access
 * grants (deriveWorkspaceRole).
 */
export function workspaceReach(row: {
  readonly visibility: string | null;
  readonly settings: unknown;
}): Pick<WorkspaceRow, "visibility" | "stickyRemoved" | "inheritOrgMembers" | "held"> {
  const settings = (row.settings ?? {}) as {
    sticky_removed?: unknown;
    inherit_organisation_members?: unknown;
  };
  return {
    visibility: (row.visibility ?? "open_to_organisation") as WorkspaceRow["visibility"],
    stickyRemoved: stickyRemovedIds(settings.sticky_removed),
    inheritOrgMembers: settings.inherit_organisation_members === true,
    held: heldForDemo(row.settings) !== null,
  };
}

/**
 * The key in workspace.settings that holds a workspace back from its own organisation: a
 * demo staff placed in an organisation its contact already works in (accounts' demo build
 * sets it, publishing with the email on clears it). The value is the demo's id. Only demo
 * code writes it.
 *
 * While it is set the workspace is not there for the organisation's people: nobody derives
 * a role in it from the organisation, its owner included (deriveWorkspaceRole), and no list
 * or count shown to them includes it (`shownToOrganisation`), the free tier's workspace
 * limit included: until it is handed over it is not the organisation's.
 */
export const HELD_FOR_DEMO = "held_for_demo";

/** The demo a workspace is held back for, or null for every other workspace. */
export function heldForDemo(settings: unknown): string | null {
  const value = (settings as Record<string, unknown> | null)?.[HELD_FOR_DEMO];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The key in workspace.settings that says a workspace was made by dembrane for a demo staff
 * placed in an organisation its contact already works in. The value is the demo's id. The
 * demo build sets it with HELD_FOR_DEMO; unlike that one, the hand-over never clears it.
 *
 * Billing reads it: a demo workspace takes no seats, so handing one over adds no seat for
 * its contact (someone with a seat elsewhere on the account keeps that one seat). A
 * commercial rule, not an access rule: access, lists and counts do not read it.
 */
export const MADE_FOR_DEMO = "made_for_demo";

/** The demo a workspace was made for, or null for every other workspace. */
export function madeForDemo(settings: unknown): string | null {
  const value = (settings as Record<string, unknown> | null)?.[MADE_FOR_DEMO];
  return typeof value === "string" && value !== "" ? value : null;
}

const heldKey = sql.raw(`'${HELD_FOR_DEMO}'`);
/**
 * heldForDemo in SQL, negated: true for a workspace its organisation's people may see. Like
 * heldForDemo, only a non-empty JSON string holds; `true`, a number or an object does not.
 */
export const shownToOrganisation: SQL = sql`not coalesce(json_typeof(${workspace.settings}->${heldKey}) = 'string' and ${workspace.settings}->>${heldKey} <> '', false)`;

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
