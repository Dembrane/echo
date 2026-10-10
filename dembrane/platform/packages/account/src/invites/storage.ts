import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, gt, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";

const {
  app_user,
  auth_user,
  directus_users,
  workspace_invite,
  org_invite,
  workspace,
  org,
  org_membership,
  workspace_membership,
  project,
  project_membership,
  billing_account,
  notification,
} = schema;

export type WorkspaceInvite = typeof workspace_invite.$inferSelect;
export type OrgInvite = typeof org_invite.$inferSelect;
export type WorkspaceRow = typeof workspace.$inferSelect;
export type AppUser = typeof app_user.$inferSelect;
type MembershipTable = typeof org_membership | typeof workspace_membership;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from paths and bodies: anything that is not a UUID cannot name a row. */
export const isUuid = (v: string) => UUID.test(v);

/** Postgres unique violation: a concurrent request already wrote the active membership. */
function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string; cause?: { code?: string } })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * Invite and membership rows. Directus returned rows in primary-key order when a query
 * had no sort, and callers depend on "the first row", so queries without an explicit sort
 * order by id.
 */
export function inviteStorage(db: Db) {
  const pendingFilter = (
    t: typeof workspace_invite | typeof org_invite,
    email: string,
    now: Date,
  ) =>
    and(
      eq(t.email, email),
      isNull(t.accepted_at),
      isNull(t.deleted_at),
      gt(t.expires_at, now.toISOString()),
    );

  return {
    async appUserByDirectusId(directusUserId: string) {
      const [row] = await db
        .select()
        .from(app_user)
        .where(eq(app_user.directus_user_id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    async appUser(id: string) {
      const [row] = await db.select().from(app_user).where(eq(app_user.id, id)).limit(1);
      return row ?? null;
    },

    async appUserNames(ids: readonly string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db
        .select({ id: app_user.id, name: app_user.display_name })
        .from(app_user)
        .where(inArray(app_user.id, [...ids]));
      return new Map(rows.map((r) => [r.id, r.name ?? ""]));
    },

    /**
     * The caller's email as their identity proves it: Better Auth's address, only once
     * verified. Invite acceptance binds to this, never to a profile copy the user can edit,
     * so changing an email cannot claim invites addressed to someone else.
     */
    async verifiedEmail(directusUserId: string) {
      const [row] = await db
        .select({ email: auth_user.email, verified: auth_user.emailVerified })
        .from(auth_user)
        .where(eq(auth_user.id, directusUserId))
        .limit(1);
      return row?.verified ? row.email.toLowerCase() : "";
    },

    async directusProfile(directusUserId: string) {
      const [row] = await db
        .select({
          email: directus_users.email,
          first: directus_users.first_name,
          last: directus_users.last_name,
        })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId))
        .limit(1);
      if (!row) return null;
      const display = `${row.first ?? ""} ${row.last ?? ""}`.trim() || (row.email ?? "");
      return { email: row.email ?? "", displayName: display };
    },

    async directusUserByEmail(email: string) {
      const [row] = await db
        .select({ id: directus_users.id })
        .from(directus_users)
        .where(eq(directus_users.email, email))
        .orderBy(asc(directus_users.id))
        .limit(1);
      return row ?? null;
    },

    // ── invites ──

    async workspaceInvite(id: string, opts: { liveOnly: boolean }) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(workspace_invite)
        .where(
          and(
            eq(workspace_invite.id, id),
            opts.liveOnly ? isNull(workspace_invite.deleted_at) : undefined,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async orgInvite(id: string, opts: { liveOnly: boolean }) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(org_invite)
        .where(
          and(eq(org_invite.id, id), opts.liveOnly ? isNull(org_invite.deleted_at) : undefined),
        )
        .limit(1);
      return row ?? null;
    },

    /** Pending (not accepted, not revoked, not expired) invites for an email; newest first or in id order. */
    async pendingWorkspaceInvites(email: string, now: Date, order: "newest" | "id" = "newest") {
      return db
        .select()
        .from(workspace_invite)
        .where(pendingFilter(workspace_invite, email, now))
        .orderBy(
          ...(order === "newest"
            ? [desc(workspace_invite.created_at), asc(workspace_invite.id)]
            : [asc(workspace_invite.id)]),
        );
    },

    async pendingOrgInvites(email: string, now: Date, order: "newest" | "id" = "newest") {
      return db
        .select()
        .from(org_invite)
        .where(pendingFilter(org_invite, email, now))
        .orderBy(
          ...(order === "newest"
            ? [desc(org_invite.created_at), asc(org_invite.id)]
            : [asc(org_invite.id)]),
        );
    },

    /** Every live (not revoked) invite for an email, accepted or not, in id order. */
    async liveWorkspaceInvites(email: string) {
      return db
        .select()
        .from(workspace_invite)
        .where(and(eq(workspace_invite.email, email), isNull(workspace_invite.deleted_at)))
        .orderBy(asc(workspace_invite.id));
    },

    async liveOrgInvites(email: string) {
      return db
        .select()
        .from(org_invite)
        .where(and(eq(org_invite.email, email), isNull(org_invite.deleted_at)))
        .orderBy(asc(org_invite.id));
    },

    /** Pending invites for one email inside a set of workspaces, in id order (the consume sweep). */
    async pendingWorkspaceInvitesIn(
      email: string,
      workspaceIds: readonly string[],
      now: Date,
      excludeId?: string,
    ) {
      if (!workspaceIds.length) return [];
      return db
        .select()
        .from(workspace_invite)
        .where(
          and(
            pendingFilter(workspace_invite, email, now),
            inArray(workspace_invite.workspace_id, [...workspaceIds]),
            excludeId ? ne(workspace_invite.id, excludeId) : undefined,
          ),
        )
        .orderBy(asc(workspace_invite.id));
    },

    async pendingOrgInvitesFor(email: string, orgId: string, now: Date, excludeId?: string) {
      return db
        .select()
        .from(org_invite)
        .where(
          and(
            pendingFilter(org_invite, email, now),
            eq(org_invite.org_id, orgId),
            excludeId ? ne(org_invite.id, excludeId) : undefined,
          ),
        )
        .orderBy(asc(org_invite.id));
    },

    /** Unaccepted, unrevoked invites for (workspace, email), expired included, in id order. */
    async openWorkspaceInvitesFor(workspaceId: string, email: string) {
      return db
        .select()
        .from(workspace_invite)
        .where(
          and(
            eq(workspace_invite.workspace_id, workspaceId),
            eq(workspace_invite.email, email),
            isNull(workspace_invite.accepted_at),
            isNull(workspace_invite.deleted_at),
          ),
        )
        .orderBy(asc(workspace_invite.id));
    },

    async pendingWorkspaceInviteFor(workspaceId: string, email: string, now: Date) {
      const [row] = await db
        .select()
        .from(workspace_invite)
        .where(
          and(
            pendingFilter(workspace_invite, email, now),
            eq(workspace_invite.workspace_id, workspaceId),
          ),
        )
        .orderBy(asc(workspace_invite.id))
        .limit(1);
      return row ?? null;
    },

    async insertWorkspaceInvite(row: typeof workspace_invite.$inferInsert) {
      await db.insert(workspace_invite).values(row);
    },

    async updateWorkspaceInvite(id: string, patch: Partial<typeof workspace_invite.$inferInsert>) {
      const rows = await db
        .update(workspace_invite)
        .set(patch)
        .where(eq(workspace_invite.id, id))
        .returning({ email: workspace_invite.email, workspaceId: workspace_invite.workspace_id });
      const at = settledAt(patch);
      for (const r of rows) {
        const scope = eq(notification.ref_workspace_id, r.workspaceId);
        if (at) await settleInviteNotices(db, r.email, scope, at);
        else if (patch.expires_at) await extendInviteNotices(db, r.email, scope, patch.expires_at);
      }
    },

    async updateOrgInvite(id: string, patch: Partial<typeof org_invite.$inferInsert>) {
      const rows = await db
        .update(org_invite)
        .set(patch)
        .where(eq(org_invite.id, id))
        .returning({ email: org_invite.email, orgId: org_invite.org_id });
      const at = settledAt(patch);
      for (const r of rows) {
        const scope = and(
          eq(notification.ref_org_id, r.orgId),
          isNull(notification.ref_workspace_id),
        ) as SQL;
        if (at) await settleInviteNotices(db, r.email, scope, at);
        else if (patch.expires_at) await extendInviteNotices(db, r.email, scope, patch.expires_at);
      }
    },

    // ── workspaces and orgs ──

    async workspace(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1);
      return row ?? null;
    },

    async liveWorkspaces(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: workspace.id, name: workspace.name, orgId: workspace.org_id })
        .from(workspace)
        .where(and(inArray(workspace.id, [...ids]), isNull(workspace.deleted_at)));
    },

    async liveWorkspaceIdsInOrg(orgId: string) {
      const rows = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(and(eq(workspace.org_id, orgId), isNull(workspace.deleted_at)))
        .orderBy(asc(workspace.id));
      return rows.map((r) => r.id);
    },

    async defaultWorkspace(orgId: string) {
      const [row] = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(
          and(
            eq(workspace.org_id, orgId),
            eq(workspace.is_default, true),
            isNull(workspace.deleted_at),
          ),
        )
        .orderBy(asc(workspace.id))
        .limit(1);
      return row ?? null;
    },

    async org(id: string) {
      const [row] = await db.select().from(org).where(eq(org.id, id)).limit(1);
      return row ?? null;
    },

    async liveOrgNames(ids: readonly string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db
        .select({ id: org.id, name: org.name })
        .from(org)
        .where(and(inArray(org.id, [...ids]), isNull(org.deleted_at)));
      return new Map(rows.map((r) => [r.id, r.name ?? ""]));
    },

    // ── memberships ──

    async orgMemberships(orgId: string, userId: string, opts: { activeOnly: boolean }) {
      return db
        .select()
        .from(org_membership)
        .where(
          and(
            eq(org_membership.org_id, orgId),
            eq(org_membership.user_id, userId),
            opts.activeOnly ? isNull(org_membership.deleted_at) : undefined,
          ),
        )
        .orderBy(asc(org_membership.id));
    },

    async ownedOrgId(userId: string) {
      const [row] = await db
        .select({ orgId: org_membership.org_id })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.user_id, userId),
            eq(org_membership.role, "owner"),
            isNull(org_membership.deleted_at),
          ),
        )
        .orderBy(asc(org_membership.id))
        .limit(1);
      return row?.orgId ?? null;
    },

    async workspaceMemberships(workspaceId: string, userId: string, opts: { activeOnly: boolean }) {
      return db
        .select()
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            eq(workspace_membership.user_id, userId),
            opts.activeOnly ? isNull(workspace_membership.deleted_at) : undefined,
          ),
        )
        .orderBy(asc(workspace_membership.id));
    },

    /**
     * Where the user already belongs: their first live workspace, a null workspace when they
     * are in an org only, or null when they belong nowhere.
     */
    async belonging(userId: string): Promise<{ workspaceId: string | null } | null> {
      const [ws] = await db
        .select({ id: workspace_membership.workspace_id })
        .from(workspace_membership)
        .innerJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
        .where(
          and(
            eq(workspace_membership.user_id, userId),
            isNull(workspace_membership.deleted_at),
            isNull(workspace.deleted_at),
          ),
        )
        .orderBy(asc(workspace_membership.id))
        .limit(1);
      if (ws) return { workspaceId: ws.id };
      const [org] = await db
        .select({ id: org_membership.id })
        .from(org_membership)
        .where(and(eq(org_membership.user_id, userId), isNull(org_membership.deleted_at)))
        .limit(1);
      return org ? { workspaceId: null } : null;
    },

    /** Roles of the user's active memberships across the org's live workspaces. */
    async workspaceRolesInOrg(orgId: string, userId: string) {
      const rows = await db
        .select({ role: workspace_membership.role })
        .from(workspace_membership)
        .innerJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
        .where(
          and(
            eq(workspace.org_id, orgId),
            isNull(workspace.deleted_at),
            eq(workspace_membership.user_id, userId),
            isNull(workspace_membership.deleted_at),
          ),
        );
      return rows.map((r) => r.role);
    },

    /** False when a concurrent request already wrote the active row. */
    async createMembership(
      table: "org" | "workspace",
      row: { orgId?: string; workspaceId?: string; userId: string; role: string; source?: string },
      now: Date,
    ): Promise<boolean> {
      const iso = now.toISOString();
      try {
        if (table === "org") {
          await db.insert(org_membership).values({
            id: newId(),
            org_id: row.orgId as string,
            user_id: row.userId,
            role: row.role,
            created_at: iso,
            updated_at: iso,
          });
        } else {
          await db.insert(workspace_membership).values({
            id: newId(),
            workspace_id: row.workspaceId as string,
            user_id: row.userId,
            role: row.role,
            source: row.source ?? "direct",
            created_at: iso,
            updated_at: iso,
          });
        }
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async updateMembership(
      table: "org" | "workspace",
      id: string,
      patch: { deleted_at?: string | null; role?: string; source?: string },
      now: Date,
    ): Promise<boolean> {
      const t: MembershipTable = table === "org" ? org_membership : workspace_membership;
      // A revived row starts clean (spec L-14): an old support expiry would lock the person
      // out silently, and old custom policies would come back with it.
      const revive =
        patch.deleted_at === null
          ? { custom_policies: [], ...(table === "workspace" && { expires_at: null }) }
          : {};
      try {
        await db
          .update(t)
          .set({ ...patch, ...revive, updated_at: now.toISOString() })
          .where(eq(t.id, id));
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    // ── onboarding writes ──

    /** Creating the app_user row is what completes onboarding; terms were accepted to get here. */
    async createAppUser(
      row: { directusUserId: string; email: string; displayName: string },
      now: Date,
    ) {
      const iso = now.toISOString();
      const [created] = await db
        .insert(app_user)
        .values({
          id: newId(),
          directus_user_id: row.directusUserId,
          email: row.email,
          display_name: row.displayName,
          terms_accepted_at: iso,
          created_at: iso,
          updated_at: iso,
        })
        .returning();
      return created ?? null;
    },

    /** Projects from before workspaces (deleted ones included, as onboarding always moved them). */
    async orphanProjectIds(directusUserId: string, limit?: number) {
      const q = db
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.directus_user_id, directusUserId), isNull(project.workspace_id)))
        .orderBy(asc(project.id));
      return (await (limit ? q.limit(limit) : q)).map((r) => r.id);
    },

    async moveProject(id: string, workspaceId: string, now: Date) {
      await db
        .update(project)
        .set({ workspace_id: workspaceId, updated_at: now.toISOString() })
        .where(eq(project.id, id));
    },

    async createOrg(row: { name: string; createdBy: string }, now: Date) {
      const id = newId();
      const iso = now.toISOString();
      await db.insert(org).values({
        id,
        name: row.name,
        created_by: row.createdBy,
        created_at: iso,
        updated_at: iso,
      });
      return id;
    },

    /** The org's billing account: its oldest live org-scoped one. */
    async orgAccountId(orgId: string) {
      const [row] = await db
        .select({ id: billing_account.id })
        .from(billing_account)
        .where(and(eq(billing_account.org_id, orgId), isNull(billing_account.deleted_at)))
        .orderBy(asc(billing_account.created_at))
        .limit(1);
      return row?.id ?? null;
    },

    async createOrgAccount(
      row: { orgId: string; tier: string; createdBy: string; label: string },
      now: Date,
    ) {
      const id = newId();
      const iso = now.toISOString();
      await db.insert(billing_account).values({
        id,
        org_id: row.orgId,
        tier: row.tier,
        payment_mode: "none",
        created_by: row.createdBy,
        label: row.label,
        created_at: iso,
        updated_at: iso,
      });
      return id;
    },

    async createWorkspace(
      row: {
        orgId: string;
        name: string;
        isDefault: boolean;
        createdBy: string;
        billingAccountId: string;
      },
      now: Date,
    ) {
      const id = newId();
      const iso = now.toISOString();
      await db.insert(workspace).values({
        id,
        org_id: row.orgId,
        name: row.name,
        is_default: row.isDefault,
        created_by: row.createdBy,
        billing_account_id: row.billingAccountId,
        created_at: iso,
        updated_at: iso,
      });
      return id;
    },

    // ── projects ──

    async project(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select({
          id: project.id,
          workspaceId: project.workspace_id,
          visibility: project.visibility,
          deletedAt: project.deleted_at,
        })
        .from(project)
        .where(eq(project.id, id))
        .limit(1);
      return row ?? null;
    },

    async upsertProjectShare(
      projectId: string,
      userId: string,
      grantedBy: string | null,
      now: Date,
    ) {
      const existing = await db
        .select({ id: project_membership.id })
        .from(project_membership)
        .where(
          and(eq(project_membership.project_id, projectId), eq(project_membership.user_id, userId)),
        )
        .limit(1);
      if (existing.length) return "exists" as const;
      await db.insert(project_membership).values({
        id: newId(),
        project_id: projectId,
        user_id: userId,
        granted_by: grantedBy,
        created_at: now.toISOString(),
      });
      return "created" as const;
    },
  };
}

export type InviteStorage = ReturnType<typeof inviteStorage>;

/** When an invite was accepted, declined or revoked; null while it is still open. */
const settledAt = (p: {
  accepted_at?: string | null | undefined;
  deleted_at?: string | null | undefined;
}) => p.accepted_at ?? p.deleted_at ?? null;

/** The invitee's unread "invited you" notices for one invite's workspace or org. */
function openInviteNotices(db: Db, email: string, scope: SQL) {
  const invitee = db
    .select({ id: app_user.id })
    .from(app_user)
    .innerJoin(auth_user, eq(auth_user.id, app_user.directus_user_id))
    .where(eq(sql`lower(${auth_user.email})`, email.toLowerCase()));
  return and(
    inArray(notification.audience_user_id, invitee),
    eq(notification.event_code, "INVITE_RECEIVED"),
    isNull(notification.read_at),
    scope,
  );
}

/** A settled invite's "invited you" notices leave the invitee's inbox. */
async function settleInviteNotices(db: Db, email: string, scope: SQL, at: string) {
  await db
    .update(notification)
    .set({ read_at: at, updated_at: at })
    .where(openInviteNotices(db, email, scope));
}

/** An extended invite's notices stay in the inbox as long as the invite does. */
async function extendInviteNotices(db: Db, email: string, scope: SQL, expiresAt: string) {
  await db
    .update(notification)
    .set({ expires_at: expiresAt, updated_at: new Date().toISOString() })
    .where(openInviteNotices(db, email, scope));
}
