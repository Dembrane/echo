import { schema } from "@echo/db";
import { and, asc, desc, eq, gte, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import { type Conn, isUuid } from "../db";

const { org, org_membership, workspace, workspace_membership, billing_account } = schema;

export type OrgRow = typeof org.$inferSelect;
export type WorkspaceRowFull = typeof workspace.$inferSelect;
export type BillingAccountRow = typeof billing_account.$inferSelect;
export type WorkspaceMembershipRow = typeof workspace_membership.$inferSelect;
export type OrgMembershipRow = typeof org_membership.$inferSelect;

// ── orgs ────────────────────────────────────────────────────────────────

export async function orgById(db: Conn, id: string): Promise<OrgRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(org).where(eq(org.id, id)).limit(1);
  return row ?? null;
}

export async function orgsByIds(db: Conn, ids: readonly string[], opts: { live?: boolean } = {}) {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  return db
    .select()
    .from(org)
    .where(and(inArray(org.id, valid), opts.live ? isNull(org.deleted_at) : undefined))
    .orderBy(asc(org.id));
}

// ── org memberships ─────────────────────────────────────────────────────

/** The caller's active org role, or null. The first row by primary key wins, as in Directus. */
export async function orgRole(db: Conn, orgId: string, userId: string): Promise<string | null> {
  if (!isUuid(orgId) || !isUuid(userId)) return null;
  const [row] = await db
    .select({ role: org_membership.role })
    .from(org_membership)
    .where(
      and(
        eq(org_membership.org_id, orgId),
        eq(org_membership.user_id, userId),
        isNull(org_membership.deleted_at),
      ),
    )
    .orderBy(asc(org_membership.id))
    .limit(1);
  return row?.role ?? null;
}

export async function activeOrgMembership(db: Conn, orgId: string, userId: string) {
  if (!isUuid(orgId) || !isUuid(userId)) return null;
  const [row] = await db
    .select()
    .from(org_membership)
    .where(
      and(
        eq(org_membership.org_id, orgId),
        eq(org_membership.user_id, userId),
        isNull(org_membership.deleted_at),
      ),
    )
    .orderBy(asc(org_membership.id))
    .limit(1);
  return row ?? null;
}

/** Any row for the pair, deleted or not: the reinvite path reactivates instead of duplicating. */
export async function anyOrgMembership(db: Conn, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(org_membership)
    .where(and(eq(org_membership.org_id, orgId), eq(org_membership.user_id, userId)))
    .orderBy(asc(org_membership.id))
    .limit(1);
  return row ?? null;
}

export async function orgMembershipsOfUser(db: Conn, userId: string) {
  return db
    .select({ org_id: org_membership.org_id, role: org_membership.role })
    .from(org_membership)
    .where(and(eq(org_membership.user_id, userId), isNull(org_membership.deleted_at)))
    .orderBy(asc(org_membership.id));
}

export async function orgMembers(db: Conn, orgId: string, roles?: readonly string[]) {
  return db
    .select({ id: org_membership.id, user_id: org_membership.user_id, role: org_membership.role })
    .from(org_membership)
    .where(
      and(
        eq(org_membership.org_id, orgId),
        isNull(org_membership.deleted_at),
        roles ? inArray(org_membership.role, [...roles]) : undefined,
      ),
    )
    .orderBy(asc(org_membership.id));
}

export async function countOrgMembers(db: Conn, orgId: string, role?: string) {
  const [row] = await db
    .select({ n: sql<number>`count(${org_membership.id})::int` })
    .from(org_membership)
    .where(
      and(
        eq(org_membership.org_id, orgId),
        isNull(org_membership.deleted_at),
        role ? eq(org_membership.role, role) : undefined,
      ),
    );
  return row?.n ?? 0;
}

// ── workspaces ──────────────────────────────────────────────────────────

export async function workspaceById(db: Conn, id: string): Promise<WorkspaceRowFull | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1);
  return row ?? null;
}

/** Live workspaces of an org in primary key order, or ordered as the caller asks. */
export async function orgWorkspaces(
  db: Conn,
  orgId: string,
  opts: { extra?: SQL; order?: SQL[] } = {},
) {
  return db
    .select()
    .from(workspace)
    .where(and(eq(workspace.org_id, orgId), isNull(workspace.deleted_at), opts.extra))
    .orderBy(...(opts.order ?? [asc(workspace.id)]));
}

export async function workspacesByIds(
  db: Conn,
  ids: readonly string[],
  opts: { live?: boolean } = {},
) {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  return db
    .select()
    .from(workspace)
    .where(and(inArray(workspace.id, valid), opts.live ? isNull(workspace.deleted_at) : undefined))
    .orderBy(asc(workspace.id));
}

export async function countOrgWorkspaces(db: Conn, orgId: string, billingAccountId?: string) {
  const [row] = await db
    .select({ n: sql<number>`count(${workspace.id})::int` })
    .from(workspace)
    .where(
      and(
        eq(workspace.org_id, orgId),
        isNull(workspace.deleted_at),
        billingAccountId ? eq(workspace.billing_account_id, billingAccountId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

// ── workspace memberships ───────────────────────────────────────────────

export async function membershipById(db: Conn, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(workspace_membership)
    .where(eq(workspace_membership.id, id))
    .limit(1);
  return row ?? null;
}

/** Active direct rows of one user across the given workspaces (or all of them). */
export async function membershipsOfUser(
  db: Conn,
  userId: string,
  opts: { workspaceIds?: readonly string[]; role?: string } = {},
) {
  if (opts.workspaceIds && !opts.workspaceIds.length) return [];
  return db
    .select()
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.user_id, userId),
        isNull(workspace_membership.deleted_at),
        opts.workspaceIds
          ? inArray(workspace_membership.workspace_id, [...opts.workspaceIds])
          : undefined,
        opts.role ? eq(workspace_membership.role, opts.role) : undefined,
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

/** The first active row for the pair, whatever its source or expiry, as the old guards read it. */
export async function activeMembership(db: Conn, workspaceId: string, userId: string) {
  if (!isUuid(workspaceId) || !isUuid(userId)) return null;
  const [row] = await db
    .select()
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.workspace_id, workspaceId),
        eq(workspace_membership.user_id, userId),
        isNull(workspace_membership.deleted_at),
      ),
    )
    .orderBy(asc(workspace_membership.id))
    .limit(1);
  return row ?? null;
}

export async function allMembershipsForPair(db: Conn, workspaceId: string, userId: string) {
  return db
    .select()
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.workspace_id, workspaceId),
        eq(workspace_membership.user_id, userId),
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

/** Active rows of a workspace; staff support rows are left out unless asked for. */
export async function workspaceMembers(
  db: Conn,
  workspaceId: string,
  opts: { includeSupport?: boolean; roles?: readonly string[] } = {},
) {
  return db
    .select()
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.workspace_id, workspaceId),
        isNull(workspace_membership.deleted_at),
        opts.includeSupport ? undefined : ne(workspace_membership.source, "staff_support"),
        opts.roles ? inArray(workspace_membership.role, [...opts.roles]) : undefined,
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

/** Active rows across several workspaces, for org-wide rollups. */
export async function membershipsIn(
  db: Conn,
  workspaceIds: readonly string[],
  opts: { userIds?: readonly string[]; role?: string } = {},
) {
  if (!workspaceIds.length || (opts.userIds && !opts.userIds.length)) return [];
  return db
    .select()
    .from(workspace_membership)
    .where(
      and(
        inArray(workspace_membership.workspace_id, [...workspaceIds]),
        isNull(workspace_membership.deleted_at),
        opts.userIds ? inArray(workspace_membership.user_id, [...opts.userIds]) : undefined,
        opts.role ? eq(workspace_membership.role, opts.role) : undefined,
      ),
    )
    .orderBy(asc(workspace_membership.id));
}

// ── billing accounts ────────────────────────────────────────────────────

export async function billingAccountById(db: Conn, id: string | null | undefined) {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(billing_account).where(eq(billing_account.id, id)).limit(1);
  return row ?? null;
}

/** The org's oldest live org-scoped account. */
export async function orgBillingAccountId(db: Conn, orgId: string) {
  const [row] = await db
    .select({ id: billing_account.id })
    .from(billing_account)
    .where(and(eq(billing_account.org_id, orgId), isNull(billing_account.deleted_at)))
    .orderBy(asc(billing_account.created_at))
    .limit(1);
  return row?.id ?? null;
}

export async function billingAccountsByIds(db: Conn, ids: readonly (string | null)[]) {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return new Map<string, BillingAccountRow>();
  const rows = await db.select().from(billing_account).where(inArray(billing_account.id, valid));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function insertBillingAccount(db: Conn, row: typeof billing_account.$inferInsert) {
  await db.insert(billing_account).values(row);
}

export async function updateBillingAccount(
  db: Conn,
  id: string,
  patch: Partial<typeof billing_account.$inferInsert>,
) {
  await db.update(billing_account).set(patch).where(eq(billing_account.id, id));
}

export async function insertWorkspace(db: Conn, row: typeof workspace.$inferInsert) {
  await db.insert(workspace).values(row);
}

export async function updateWorkspace(
  db: Conn,
  id: string,
  patch: Partial<typeof workspace.$inferInsert>,
) {
  await db.update(workspace).set(patch).where(eq(workspace.id, id));
}

export async function insertMembership(db: Conn, row: typeof workspace_membership.$inferInsert) {
  await db.insert(workspace_membership).values(row);
}

export async function updateMembership(
  db: Conn,
  id: string,
  patch: Partial<typeof workspace_membership.$inferInsert>,
) {
  await db.update(workspace_membership).set(patch).where(eq(workspace_membership.id, id));
}

/** Active admin or owner rows of a workspace, staff support rows left out. */
export async function countManagers(db: Conn, workspaceId: string, roles: readonly string[]) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.workspace_id, workspaceId),
        inArray(workspace_membership.role, [...roles]),
        isNull(workspace_membership.deleted_at),
        ne(workspace_membership.source, "staff_support"),
      ),
    );
  return row?.n ?? 0;
}

/** The caller's first org (by row) where they are admin or owner. */
export async function firstManagedOrg(db: Conn, userId: string) {
  const [row] = await db
    .select({ org_id: org_membership.org_id })
    .from(org_membership)
    .where(
      and(
        eq(org_membership.user_id, userId),
        inArray(org_membership.role, ["owner", "admin"]),
        isNull(org_membership.deleted_at),
      ),
    )
    .orderBy(asc(org_membership.id))
    .limit(1);
  return row?.org_id ?? null;
}

/** Rows deleted since `cutoffIso`, newest first: the "your access ended" notice. */
export async function recentRemovals(db: Conn, userId: string, cutoffIso: string) {
  return db
    .select({
      workspace_id: workspace_membership.workspace_id,
      deleted_at: workspace_membership.deleted_at,
    })
    .from(workspace_membership)
    .where(
      and(
        eq(workspace_membership.user_id, userId),
        gte(workspace_membership.deleted_at, cutoffIso),
      ),
    )
    .orderBy(desc(workspace_membership.deleted_at))
    .limit(5);
}

/** Distinct user ids with an active row on any of the workspaces, per workspace. */
export async function memberIdsByWorkspace(db: Conn, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  return db
    .select({
      workspace_id: workspace_membership.workspace_id,
      user_id: workspace_membership.user_id,
    })
    .from(workspace_membership)
    .where(
      and(
        inArray(workspace_membership.workspace_id, [...workspaceIds]),
        isNull(workspace_membership.deleted_at),
      ),
    );
}

export async function workspaceNames(db: Conn, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(inArray(workspace.id, [...ids]));
  return new Map(rows.map((w) => [w.id, w.name ?? ""]));
}

export async function distinctAccountsOf(db: Conn, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  const rows = await db
    .selectDistinct({ id: workspace.billing_account_id })
    .from(workspace)
    .where(inArray(workspace.id, [...workspaceIds]));
  return rows.map((r) => r.id);
}

/** Live workspaces of an org by name; members discover only the open ones. */
export async function discoverableWorkspaces(db: Conn, orgId: string, openOnly: boolean) {
  return orgWorkspaces(db, orgId, {
    ...(openOnly && { extra: eq(workspace.visibility, "open_to_organisation") }),
    order: [asc(workspace.name)],
  });
}

/** Live workspaces of an org as the overview lists them: default first, then by name. */
export async function orgWorkspacesForCards(
  db: Conn,
  orgId: string,
  onlyIds: readonly string[] | null,
) {
  return orgWorkspaces(db, orgId, {
    ...(onlyIds && { extra: inArray(workspace.id, [...onlyIds]) }),
    order: [desc(workspace.is_default), asc(workspace.name)],
  });
}
