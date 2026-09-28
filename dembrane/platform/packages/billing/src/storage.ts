import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { AccountPatch, BillingStore, NotificationRow } from "./store";

const {
  billing_account,
  workspace,
  workspace_membership,
  org_membership,
  workspace_invite,
  app_user,
  org,
  project,
  notification,
  conversation,
} = schema;

export function billingStorage(db: Db): BillingStore {
  return {
    async account(id) {
      const [row] = await db.select().from(billing_account).where(eq(billing_account.id, id));
      return row ?? null;
    },

    async updateAccount(id, patch: AccountPatch, now) {
      await db
        .update(billing_account)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(billing_account.id, id));
    },

    async accountWorkspaceIds(accountId) {
      const rows = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(and(eq(workspace.billing_account_id, accountId), isNull(workspace.deleted_at)))
        .orderBy(asc(workspace.id));
      return rows.map((r) => r.id);
    },

    async workspace(id) {
      const [row] = await db
        .select({
          id: workspace.id,
          name: workspace.name,
          org_id: workspace.org_id,
          visibility: workspace.visibility,
          settings: workspace.settings,
          deleted_at: workspace.deleted_at,
          billing_account_id: workspace.billing_account_id,
        })
        .from(workspace)
        .where(eq(workspace.id, id));
      return row ?? null;
    },

    async directMemberships(workspaceId) {
      return db
        .select({
          user_id: workspace_membership.user_id,
          role: workspace_membership.role,
          source: workspace_membership.source,
          created_at: workspace_membership.created_at,
          custom_policies: workspace_membership.custom_policies,
        })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            isNull(workspace_membership.deleted_at),
            ne(workspace_membership.source, "staff_support"),
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    async orgMemberships(orgId, roles) {
      if (!roles.length) return [];
      return db
        .select({ user_id: org_membership.user_id, role: org_membership.role })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.org_id, orgId),
            inArray(org_membership.role, [...roles]),
            isNull(org_membership.deleted_at),
          ),
        )
        .orderBy(asc(org_membership.id));
    },

    async pendingInvites(workspaceId, now) {
      return db
        .select({ email: workspace_invite.email, role: workspace_invite.role })
        .from(workspace_invite)
        .where(
          and(
            eq(workspace_invite.workspace_id, workspaceId),
            isNull(workspace_invite.accepted_at),
            isNull(workspace_invite.deleted_at),
            gt(workspace_invite.expires_at, now.toISOString()),
          ),
        )
        .orderBy(asc(workspace_invite.id));
    },

    async appUser(id) {
      const [row] = await db
        .select({ id: app_user.id, email: app_user.email, display_name: app_user.display_name })
        .from(app_user)
        .where(eq(app_user.id, id));
      return row ?? null;
    },

    async appUsers(ids) {
      if (!ids.length) return [];
      return db
        .select({
          id: app_user.id,
          email: app_user.email,
          display_name: app_user.display_name,
          language: schema.directus_users.language,
        })
        .from(app_user)
        .leftJoin(schema.directus_users, eq(schema.directus_users.id, app_user.directus_user_id))
        .where(inArray(app_user.id, [...ids]))
        .orderBy(asc(app_user.id));
    },

    async orgAccountId(orgId) {
      const [row] = await db
        .select({ id: billing_account.id })
        .from(billing_account)
        .where(and(eq(billing_account.org_id, orgId), isNull(billing_account.deleted_at)))
        .orderBy(asc(billing_account.created_at), asc(billing_account.id))
        .limit(1);
      return row?.id ?? null;
    },

    async hasOrgRole(orgId, appUserId, roles) {
      const rows = await db
        .select({ id: org_membership.id })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.user_id, appUserId),
            eq(org_membership.org_id, orgId),
            inArray(org_membership.role, [...roles]),
            isNull(org_membership.deleted_at),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async orgName(id) {
      const [row] = await db.select({ name: org.name }).from(org).where(eq(org.id, id));
      return row?.name ?? null;
    },

    async projectName(id) {
      const [row] = await db.select({ name: project.name }).from(project).where(eq(project.id, id));
      return row?.name ?? null;
    },

    async insertNotification(row: NotificationRow, now) {
      const iso = now.toISOString();
      await db.insert(notification).values({ ...row, created_at: iso, updated_at: iso });
    },

    async clearWorkspaceLogo(workspaceId, now) {
      await db
        .update(workspace)
        .set({ logo_url: null, updated_at: now.toISOString() })
        .where(eq(workspace.id, workspaceId));
    },

    async clearOverCapStamps(workspaceId, now) {
      const projectIds = db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.workspace_id, workspaceId));
      const rows = await db
        .update(conversation)
        .set({ is_over_cap: false, updated_at: now.toISOString() })
        .where(
          and(inArray(conversation.project_id, projectIds), eq(conversation.is_over_cap, true)),
        )
        .returning({ id: conversation.id });
      return rows.length;
    },

    async claimPrewarning(accountId, now) {
      const rows = await db
        .update(billing_account)
        .set({ pre_warning_sent: true, updated_at: now.toISOString() })
        .where(and(eq(billing_account.id, accountId), eq(billing_account.pre_warning_sent, false)))
        .returning({ id: billing_account.id });
      return rows.length > 0;
    },

    async pendingAccountsWithCustomer() {
      const rows = await db
        .select({ id: billing_account.id })
        .from(billing_account)
        .where(
          and(
            eq(billing_account.status, "pending"),
            isNotNull(billing_account.mollie_customer_id),
            isNull(billing_account.deleted_at),
          ),
        )
        .orderBy(asc(billing_account.id));
      return rows.map((r) => r.id);
    },

    async activeAccountsWithSubscription() {
      const rows = await db
        .select({ id: billing_account.id })
        .from(billing_account)
        .where(
          and(
            eq(billing_account.status, "active"),
            isNotNull(billing_account.mollie_subscription_id),
            isNull(billing_account.deleted_at),
          ),
        )
        .orderBy(asc(billing_account.id));
      return rows.map((r) => r.id);
    },

    async expiredTierAccounts(now) {
      return db
        .select({
          id: billing_account.id,
          tier: billing_account.tier,
          workspace_id: billing_account.workspace_id,
        })
        .from(billing_account)
        .where(
          and(
            isNotNull(billing_account.tier_expires_at),
            lt(billing_account.tier_expires_at, now.toISOString()),
            ne(billing_account.tier, "free"),
            ne(billing_account.payment_mode, "offline"),
            isNull(billing_account.deleted_at),
          ),
        )
        .orderBy(asc(billing_account.id));
    },

    async prewarnAccounts(from, until) {
      return db
        .select({
          id: billing_account.id,
          tier: billing_account.tier,
          tier_expires_at: billing_account.tier_expires_at,
          workspace_id: billing_account.workspace_id,
        })
        .from(billing_account)
        .where(
          and(
            isNotNull(billing_account.tier_expires_at),
            gte(billing_account.tier_expires_at, from.toISOString()),
            lte(billing_account.tier_expires_at, until.toISOString()),
            ne(billing_account.tier, "free"),
            eq(billing_account.pre_warning_sent, false),
            ne(billing_account.payment_mode, "offline"),
            isNull(billing_account.deleted_at),
          ),
        )
        .orderBy(asc(billing_account.id));
    },
  };
}

/**
 * A per-key lock held for the duration of fn, or undefined when another holder has it.
 * A transaction-scoped advisory lock, so a crashed holder can never wedge the key.
 */
export function pgTryLock(db: Db) {
  return async <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> =>
    db.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext(${key})) as got`,
      )) as unknown as { got: boolean }[];
      if (!rows[0]?.got) return undefined;
      return fn();
    });
}
