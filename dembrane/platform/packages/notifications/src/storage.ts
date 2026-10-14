import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";

const {
  notification,
  app_user,
  directus_users,
  org,
  workspace,
  project,
  org_membership,
  workspace_membership,
  project_membership,
} = schema;

export type NotificationInsert = typeof notification.$inferInsert;

export function notificationStorage(db: Db) {
  const live = (appUserId: string, nowIso: string) =>
    and(
      eq(notification.audience_user_id, appUserId),
      or(isNull(notification.expires_at), gt(notification.expires_at, nowIso)),
    );

  return {
    /** Newest first. Directus sorted by created_at alone; id breaks ties so pages are stable. */
    async list(appUserId: string, now: Date, unreadOnly: boolean, limit: number) {
      return db
        .select()
        .from(notification)
        .where(
          and(
            live(appUserId, now.toISOString()),
            unreadOnly ? isNull(notification.read_at) : undefined,
          ),
        )
        .orderBy(desc(notification.created_at), desc(notification.id))
        .limit(limit);
    },

    async unreadCount(appUserId: string, now: Date) {
      const rows = await db
        .select({ id: notification.id })
        .from(notification)
        .where(and(live(appUserId, now.toISOString()), isNull(notification.read_at)));
      return rows.length;
    },

    async byId(id: string) {
      const [row] = await db
        .select({ audience: notification.audience_user_id, readAt: notification.read_at })
        .from(notification)
        .where(eq(notification.id, id))
        .limit(1);
      return row ?? null;
    },

    async markRead(ids: readonly string[], now: Date) {
      if (!ids.length) return;
      const iso = now.toISOString();
      await db
        .update(notification)
        .set({ read_at: iso, updated_at: iso })
        .where(inArray(notification.id, [...ids]));
    },

    /** The newest 500 unread, expired or not: the drawer never pages further back. */
    async unreadIds(appUserId: string) {
      const rows = await db
        .select({ id: notification.id })
        .from(notification)
        .where(and(eq(notification.audience_user_id, appUserId), isNull(notification.read_at)))
        .orderBy(desc(notification.created_at), desc(notification.id))
        .limit(500);
      return rows.map((r) => r.id);
    },

    async actors(appUserIds: readonly string[]) {
      if (!appUserIds.length) return [];
      return db
        .select({
          id: app_user.id,
          displayName: app_user.display_name,
          avatar: directus_users.avatar,
        })
        .from(app_user)
        .leftJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
        .where(inArray(app_user.id, [...appUserIds]));
    },

    async insert(row: NotificationInsert) {
      await db.insert(notification).values(row);
    },

    async names(refs: {
      orgId?: string | null;
      workspaceId?: string | null;
      projectId?: string | null;
    }) {
      const one = async (t: typeof org | typeof workspace | typeof project, id?: string | null) => {
        if (!id) return null;
        const [row] = await db.select({ name: t.name }).from(t).where(eq(t.id, id)).limit(1);
        return row?.name ?? null;
      };
      return {
        org: await one(org, refs.orgId),
        workspace: await one(workspace, refs.workspaceId),
        project: await one(project, refs.projectId),
      };
    },

    /** Active org memberships in primary-key order, the order Directus returned them. */
    async orgMembers(orgId: string, roles: readonly string[]) {
      return db
        .select({ userId: org_membership.user_id, role: org_membership.role })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.org_id, orgId),
            isNull(org_membership.deleted_at),
            inArray(org_membership.role, [...roles]),
          ),
        )
        .orderBy(asc(org_membership.id));
    },

    async workspaceForMembers(workspaceId: string) {
      const [row] = await db
        .select({
          orgId: workspace.org_id,
          visibility: workspace.visibility,
          settings: workspace.settings,
          deletedAt: workspace.deleted_at,
        })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .limit(1);
      return row ?? null;
    },

    async projectForAudience(projectId: string) {
      const [row] = await db
        .select({
          workspaceId: project.workspace_id,
          visibility: project.visibility,
          deletedAt: project.deleted_at,
        })
        .from(project)
        .where(eq(project.id, projectId))
        .limit(1);
      return row ?? null;
    },

    async projectShares(projectId: string) {
      return db
        .select({ userId: project_membership.user_id })
        .from(project_membership)
        .where(eq(project_membership.project_id, projectId))
        .orderBy(asc(project_membership.id));
    },

    async directMembers(workspaceId: string) {
      return db
        .select({ userId: workspace_membership.user_id, role: workspace_membership.role })
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

    /**
     * app_user ids of every onboarded user with Directus admin access (staff): an admin
     * policy attached to the user directly or through their role, as Directus computes it.
     */
    async staffIds() {
      const { directus_access: access, directus_policies: policies } = schema;
      const rows = await db
        .select({ id: app_user.id })
        .from(app_user)
        .innerJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(access)
              .innerJoin(policies, eq(policies.id, access.policy))
              .where(
                and(
                  eq(policies.admin_access, true),
                  or(eq(access.user, directus_users.id), eq(access.role, directus_users.role)),
                ),
              ),
          ),
        )
        .orderBy(asc(app_user.id));
      return rows.map((r) => r.id);
    },
  };
}

export type NotificationStorage = ReturnType<typeof notificationStorage>;
