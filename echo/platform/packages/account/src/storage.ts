import { newId } from "@echo/core";
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

    /** Reads the row under FOR UPDATE, then writes what `change` returns, in one transaction. */
    async updateAppUserLocked(
      id: string,
      now: Date,
      change: (fresh: typeof app_user.$inferSelect) => Partial<typeof app_user.$inferInsert>,
    ) {
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(app_user).where(eq(app_user.id, id)).for("update");
        if (!fresh) return;
        await tx
          .update(app_user)
          .set({ ...change(fresh), updated_at: now.toISOString() })
          .where(eq(app_user.id, id));
      });
    },

    async setOnboardingAnswers(id: string, answers: Record<string, unknown>, now: Date) {
      await db
        .update(app_user)
        .set({ onboarding_answer_json: answers, updated_at: now.toISOString() })
        .where(eq(app_user.id, id));
    },

    /** Whether an email already has an identity, in Directus or in Better Auth. */
    async identityExists(email: string) {
      const [d] = await db
        .select({ id: directus_users.id })
        .from(directus_users)
        .where(eq(directus_users.email, email))
        .limit(1);
      if (d) return true;
      const [a] = await db
        .select({ id: schema.auth_user.id })
        .from(schema.auth_user)
        .where(eq(schema.auth_user.email, email))
        .limit(1);
      return Boolean(a);
    },

    /**
     * After a Better Auth signup: the Directus row keeps the names exactly as entered and
     * the same password hash, so until cutover the account works wherever it signs in.
     */
    async syncRegisteredProfile(userId: string, p: { firstName: string; lastName: string | null }) {
      const [acc] = await db
        .select({ password: schema.auth_account.password })
        .from(schema.auth_account)
        .where(
          and(
            eq(schema.auth_account.userId, userId),
            eq(schema.auth_account.providerId, "credential"),
          ),
        )
        .limit(1);
      await db
        .update(directus_users)
        .set({ first_name: p.firstName, last_name: p.lastName, password: acc?.password ?? null })
        .where(eq(directus_users.id, userId));
    },

    async settingsProfile(directusUserId: string) {
      const [row] = await db
        .select({
          id: directus_users.id,
          first_name: directus_users.first_name,
          email: directus_users.email,
          avatar: directus_users.avatar,
          disable_create_project: directus_users.disable_create_project,
          whitelabel_logo: directus_users.whitelabel_logo,
          hide_ai_suggestions: directus_users.hide_ai_suggestions,
        })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    /** Profile fields of the caller's own Directus row; identity fields go through the auth package. */
    async updateDirectusUser(
      directusUserId: string,
      patch: { first_name?: string; avatar?: string | null; whitelabel_logo?: string | null },
    ) {
      await db.update(directus_users).set(patch).where(eq(directus_users.id, directusUserId));
    },

    async directusFileRef(directusUserId: string, field: "avatar" | "whitelabel_logo") {
      const [row] = await db
        .select({ ref: directus_users[field] })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId))
        .limit(1);
      return row?.ref ?? null;
    },

    async updateAppUserDisplayName(id: string, name: string, now: Date) {
      await db
        .update(app_user)
        .set({ display_name: name, updated_at: now.toISOString() })
        .where(eq(app_user.id, id));
    },

    async folderId(name: string) {
      const [row] = await db
        .select({ id: schema.directus_folders.id })
        .from(schema.directus_folders)
        .where(eq(schema.directus_folders.name, name))
        .orderBy(asc(schema.directus_folders.id))
        .limit(1);
      return row?.id ?? null;
    },

    async createFolder(name: string) {
      const id = newId();
      await db.insert(schema.directus_folders).values({ id, name });
      return id;
    },

    async insertFile(
      row: Omit<typeof schema.directus_files.$inferInsert, "uploaded_on" | "created_on">,
      now: Date,
    ) {
      const iso = now.toISOString();
      await db.insert(schema.directus_files).values({ ...row, uploaded_on: iso, created_on: iso });
    },

    /** Deletes the file row; returns its object key so the caller removes the bytes too. */
    async deleteFile(id: string) {
      const [row] = await db
        .delete(schema.directus_files)
        .where(eq(schema.directus_files.id, id))
        .returning({ disk: schema.directus_files.filename_disk });
      return row?.disk ?? null;
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
