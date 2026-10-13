import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

const {
  workspace,
  billing_account,
  org,
  org_membership,
  workspace_membership,
  project,
  conversation,
  app_user,
  directus_users,
  auth_session,
  referral_ledger,
  support_access_request,
  support_access_event,
} = schema;

/** Staff console queries. Each mirrors the Directus query of the old route (id order, soft deletes filtered here). */
export function staffStorage(db: Db) {
  return {
    /** Live workspaces with their billing account's commercial fields, for the rollup. */
    async rollupWorkspaces() {
      return db
        .select({
          id: workspace.id,
          name: workspace.name,
          org_id: workspace.org_id,
          visibility: workspace.visibility,
          settings: workspace.settings,
          billed_to_team_id: workspace.billed_to_team_id,
          account_id: billing_account.id,
          account_org_id: billing_account.org_id,
          account_workspace_id: billing_account.workspace_id,
          payment_mode: billing_account.payment_mode,
          label: billing_account.label,
          tier: billing_account.tier,
          tier_expires_at: billing_account.tier_expires_at,
          downgraded_at: billing_account.downgraded_at,
          downgraded_from_tier: billing_account.downgraded_from_tier,
          percent_discount: billing_account.percent_discount,
          type_discount: billing_account.type_discount,
          billing_period: billing_account.billing_period,
        })
        .from(workspace)
        .leftJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
        .where(isNull(workspace.deleted_at))
        .orderBy(asc(workspace.id));
    },

    async orgs(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: org.id, name: org.name, is_partner: org.is_partner })
        .from(org)
        .where(inArray(org.id, [...new Set(ids)]))
        .orderBy(asc(org.id));
    },

    async liveProjects(workspaceIds: readonly string[]) {
      if (!workspaceIds.length) return [];
      // A sample copy's invented hours are no customer's usage.
      return db
        .select({ id: project.id, workspace_id: project.workspace_id })
        .from(project)
        .where(
          and(
            inArray(project.workspace_id, [...workspaceIds]),
            isNull(project.deleted_at),
            eq(project.is_sample, false),
          ),
        )
        .orderBy(asc(project.id));
    },

    /** Seconds recorded per project in [start, end), live conversations only. */
    async secondsByProject(projectIds: readonly string[], start: string, end: string) {
      if (!projectIds.length) return [];
      return db
        .select({
          project_id: conversation.project_id,
          seconds: sql<string | null>`sum(${conversation.duration})`,
        })
        .from(conversation)
        .where(
          and(
            inArray(conversation.project_id, [...projectIds]),
            gte(conversation.created_at, start),
            lt(conversation.created_at, end),
            isNull(conversation.deleted_at),
          ),
        )
        .groupBy(conversation.project_id);
    },

    /** Every live membership row of the workspaces, staff support included, in id order. */
    async memberships(workspaceIds: readonly string[]) {
      if (!workspaceIds.length) return [];
      return db
        .select({
          id: workspace_membership.id,
          workspace_id: workspace_membership.workspace_id,
          user_id: workspace_membership.user_id,
          role: workspace_membership.role,
          source: workspace_membership.source,
        })
        .from(workspace_membership)
        .where(
          and(
            inArray(workspace_membership.workspace_id, [...workspaceIds]),
            isNull(workspace_membership.deleted_at),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async orgMembershipsIn(orgIds: readonly string[], roles: readonly string[]) {
      if (!orgIds.length) return [];
      return db
        .select({
          org_id: org_membership.org_id,
          user_id: org_membership.user_id,
          role: org_membership.role,
        })
        .from(org_membership)
        .where(
          and(
            inArray(org_membership.org_id, [...orgIds]),
            inArray(org_membership.role, [...roles]),
            isNull(org_membership.deleted_at),
          ),
        )
        .orderBy(asc(org_membership.id));
    },

    async appUsers(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: app_user.id, email: app_user.email, display_name: app_user.display_name })
        .from(app_user)
        .where(inArray(app_user.id, [...new Set(ids)]))
        .orderBy(asc(app_user.id));
    },

    async appUserByDirectusId(directusUserId: string) {
      const [row] = await db
        .select({ id: app_user.id, email: app_user.email, display_name: app_user.display_name })
        .from(app_user)
        .where(eq(app_user.directus_user_id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    /**
     * App users seen in the last 30 days: a Directus login (last_access) or a platform
     * session started since. Both count while the two sign-ins run side by side.
     */
    async recentLoginCount(since: string) {
      const [row] = await db
        .select({ n: sql<number>`count(distinct ${app_user.id})::int` })
        .from(app_user)
        .innerJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
        .where(
          or(
            gte(directus_users.last_access, since),
            sql`exists (select 1 from ${auth_session} where ${auth_session.userId} = ${directus_users.id} and ${auth_session.createdAt} >= ${since})`,
          ),
        );
      return row?.n ?? 0;
    },

    async referralLedger() {
      return db
        .select({
          id: referral_ledger.id,
          workspace_id: referral_ledger.workspace_id,
          partner_team_id: referral_ledger.partner_team_id,
          partner_kickback_percent: referral_ledger.partner_kickback_percent,
          starts_at: referral_ledger.starts_at,
          expires_at: referral_ledger.expires_at,
          notes: referral_ledger.notes,
        })
        .from(referral_ledger)
        .orderBy(desc(referral_ledger.starts_at), asc(referral_ledger.id));
    },

    async workspaceNames(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: workspace.id, name: workspace.name, org_id: workspace.org_id })
        .from(workspace)
        .where(inArray(workspace.id, [...new Set(ids)]))
        .orderBy(asc(workspace.id));
    },

    async externalMemberships() {
      return db
        .select({
          user_id: workspace_membership.user_id,
          workspace_id: workspace_membership.workspace_id,
        })
        .from(workspace_membership)
        .where(
          and(eq(workspace_membership.role, "external"), isNull(workspace_membership.deleted_at)),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async partnerOrgs(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: org.id, name: org.name })
        .from(org)
        .where(and(inArray(org.id, [...new Set(ids)]), eq(org.is_partner, true)))
        .orderBy(asc(org.id));
    },

    async orgsCreatedBy(userIds: readonly string[]) {
      if (!userIds.length) return [];
      return db
        .select({
          id: org.id,
          name: org.name,
          created_at: org.created_at,
          created_by: org.created_by,
        })
        .from(org)
        .where(and(inArray(org.created_by, [...userIds]), isNull(org.deleted_at)))
        .orderBy(desc(org.created_at), asc(org.id));
    },

    async workspace(id: string) {
      const [row] = await db.select().from(workspace).where(eq(workspace.id, id));
      return row ?? null;
    },

    async updateWorkspace(id: string, patch: Partial<typeof workspace.$inferInsert>, now: Date) {
      await db
        .update(workspace)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(workspace.id, id));
    },

    async org(id: string) {
      const [row] = await db.select().from(org).where(eq(org.id, id));
      return row ?? null;
    },

    async updateOrg(id: string, patch: Partial<typeof org.$inferInsert>, now: Date) {
      await db
        .update(org)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(org.id, id));
    },

    async membership(id: string) {
      const [row] = await db
        .select()
        .from(workspace_membership)
        .where(eq(workspace_membership.id, id));
      return row ?? null;
    },

    async workspaceMemberships(workspaceId: string) {
      return db
        .select({
          id: workspace_membership.id,
          user_id: workspace_membership.user_id,
          role: workspace_membership.role,
        })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            isNull(workspace_membership.deleted_at),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async updateMembership(
      id: string,
      patch: Partial<typeof workspace_membership.$inferInsert>,
      now: Date,
    ) {
      await db
        .update(workspace_membership)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(workspace_membership.id, id));
    },

    async insertMembership(row: typeof workspace_membership.$inferInsert) {
      await db.insert(workspace_membership).values(row);
    },

    /** Every row of this user on this workspace, soft-deleted ones included, in id order. */
    async userMemberships(workspaceId: string, appUserId: string) {
      return db
        .select({
          id: workspace_membership.id,
          role: workspace_membership.role,
          source: workspace_membership.source,
          deleted_at: workspace_membership.deleted_at,
        })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            eq(workspace_membership.user_id, appUserId),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async supportRows(workspaceId: string, appUserId?: string) {
      return db
        .select({ id: workspace_membership.id, expires_at: workspace_membership.expires_at })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            ...(appUserId ? [eq(workspace_membership.user_id, appUserId)] : []),
            eq(workspace_membership.source, "staff_support"),
            isNull(workspace_membership.deleted_at),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async overdueSupportRows(now: string) {
      return db
        .select({ id: workspace_membership.id, workspace_id: workspace_membership.workspace_id })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.source, "staff_support"),
            isNull(workspace_membership.deleted_at),
            isNotNull(workspace_membership.expires_at),
            lt(workspace_membership.expires_at, now),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async ownRequests(workspaceId: string, appUserId: string, status?: string) {
      return db
        .select()
        .from(support_access_request)
        .where(
          and(
            eq(support_access_request.workspace_id, workspaceId),
            eq(support_access_request.requested_by, appUserId),
            ...(status ? [eq(support_access_request.status, status)] : []),
          ),
        )
        .orderBy(desc(support_access_request.created_at))
        .limit(1);
    },

    async request(id: string) {
      const [row] = await db
        .select()
        .from(support_access_request)
        .where(eq(support_access_request.id, id));
      return row ?? null;
    },

    async insertRequest(row: typeof support_access_request.$inferInsert) {
      await db.insert(support_access_request).values(row);
    },

    async updateRequest(id: string, patch: Partial<typeof support_access_request.$inferInsert>) {
      await db.update(support_access_request).set(patch).where(eq(support_access_request.id, id));
    },

    async insertEvent(row: typeof support_access_event.$inferInsert) {
      await db.insert(support_access_event).values(row);
    },

    async accountsWithCustomer() {
      return db
        .select({
          id: billing_account.id,
          label: billing_account.label,
          org_id: billing_account.org_id,
          tier: billing_account.tier,
          mollie_customer_id: billing_account.mollie_customer_id,
        })
        .from(billing_account)
        .where(
          and(isNull(billing_account.deleted_at), isNotNull(billing_account.mollie_customer_id)),
        )
        .orderBy(asc(billing_account.id));
    },
  };
}

export type StaffStorage = ReturnType<typeof staffStorage>;
