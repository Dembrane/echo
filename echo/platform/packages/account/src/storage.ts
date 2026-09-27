import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";

const {
  directus_users,
  app_user,
  project,
  workspace_invite,
  org_invite,
  org_membership,
  org,
  training_license,
} = schema;

export function accountStorage(db: Db) {
  return {
    async directusProfile(directusUserId: string) {
      const [row] = await db
        .select({
          email: directus_users.email,
          first: directus_users.first_name,
          last: directus_users.last_name,
          avatar: directus_users.avatar,
        })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    async appUser(directusUserId: string) {
      const [row] = await db
        .select()
        .from(app_user)
        .where(eq(app_user.directus_user_id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    async hasLegacyProjects(directusUserId: string) {
      const rows = await db
        .select({ id: project.id })
        .from(project)
        .where(
          and(
            eq(project.directus_user_id, directusUserId),
            isNull(project.workspace_id),
            isNull(project.deleted_at),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /** Pending workspace invites first, then org invites, as onboarding counts both. */
    async hasPendingInvites(email: string, now: Date) {
      const iso = now.toISOString();
      const ws = await db
        .select({ id: workspace_invite.id })
        .from(workspace_invite)
        .where(
          and(
            eq(workspace_invite.email, email),
            isNull(workspace_invite.accepted_at),
            isNull(workspace_invite.deleted_at),
            gt(workspace_invite.expires_at, iso),
          ),
        )
        .limit(1);
      if (ws.length) return true;
      const o = await db
        .select({ id: org_invite.id })
        .from(org_invite)
        .where(
          and(
            eq(org_invite.email, email),
            isNull(org_invite.accepted_at),
            isNull(org_invite.deleted_at),
            gt(org_invite.expires_at, iso),
          ),
        )
        .limit(1);
      return o.length > 0;
    },

    /** Active org memberships with their live orgs, in membership order (Directus sorts by primary key). */
    async orgSummaries(appUserId: string) {
      const memberships = await db
        .select({ orgId: org_membership.org_id, role: org_membership.role })
        .from(org_membership)
        .where(and(eq(org_membership.user_id, appUserId), isNull(org_membership.deleted_at)))
        .orderBy(asc(org_membership.id));
      const ids = memberships.map((m) => m.orgId).filter(Boolean);
      if (!ids.length) return [];
      const orgs = await db
        .select({ id: org.id, name: org.name, isPartner: org.is_partner })
        .from(org)
        .where(and(inArray(org.id, ids), isNull(org.deleted_at)));
      const byId = new Map(orgs.map((o) => [o.id, o]));
      return memberships.flatMap((m) => {
        const o = byId.get(m.orgId);
        return o
          ? [{ id: o.id, name: o.name ?? "", role: m.role, is_partner: Boolean(o.isPartner) }]
          : [];
      });
    },

    async licenses(appUserId: string) {
      return db
        .select({ status: training_license.status, expiresAt: training_license.expires_at })
        .from(training_license)
        .where(eq(training_license.app_user_id, appUserId))
        .orderBy(desc(training_license.expires_at));
    },
  };
}

export type AccountStorage = ReturnType<typeof accountStorage>;
