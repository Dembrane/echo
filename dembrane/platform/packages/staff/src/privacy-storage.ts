import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const {
  account_document,
  account_event,
  account_signature,
  account_ticket_message,
  agent_audit_event,
  agent_grant,
  agent_memory,
  agent_token,
  app_user,
  auth_account,
  auth_session,
  auth_user,
  auth_verification,
  conversation,
  conversation_chunk,
  directus_files,
  directus_roles,
  directus_users,
  model_response_feedback,
  notification,
  org,
  org_invite,
  org_membership,
  pricing_configuration,
  project,
  project_chat,
  project_chat_message,
  project_membership,
  project_report_notification_participants,
  staff_audit_event,
  support_access_event,
  support_request,
  usage_insight,
  workspace,
  workspace_invite,
  workspace_membership,
  announcement_activity,
} = schema;

/** The ids one person has: Better Auth and Directus share `id`; `appId` is null before onboarding. */
export interface Person {
  readonly id: string;
  readonly appId: string | null;
  readonly email: string;
  readonly role: string | null;
}

/**
 * Columns that reference directus_users with no ON DELETE rule. Erasing a person clears
 * them first, so the rows (shared chats, webhooks, uploads, announcements others read) stay
 * and only lose their author. A test compares this list with the database's constraints, so
 * a new such reference fails there, not in an erasure.
 */
export const AUTHOR_COLUMNS: readonly (readonly [string, string])[] = [
  ["announcement", "user_created"],
  ["announcement", "user_updated"],
  ["announcement_activity", "user_created"],
  ["announcement_activity", "user_updated"],
  ["conversation_artifact", "user_created"],
  ["conversation_artifact", "user_updated"],
  ["directus_comments", "user_updated"],
  ["directus_files", "modified_by"],
  ["directus_files", "uploaded_by"],
  ["directus_notifications", "sender"],
  ["directus_versions", "user_updated"],
  ["project_chat", "user_created"],
  ["project_chat", "user_updated"],
  ["project_webhook", "user_created"],
  ["project_webhook", "user_updated"],
  ["prompt_template", "user_created"],
  ["verification_topic", "user_created"],
  ["verification_topic", "user_updated"],
];

const lowerEq = (col: AnyPgColumn, email: string) => sql`lower(${col}) = ${email}`;

/** Every query a data subject request needs: find one person, read their rows, erase them. */
export function privacyStorage(db: Db) {
  return {
    async person(email: string): Promise<Person | null> {
      const e = email.trim().toLowerCase();
      const [row] = await db
        .select({
          id: directus_users.id,
          email: directus_users.email,
          role: directus_roles.name,
          appId: app_user.id,
        })
        .from(directus_users)
        .leftJoin(directus_roles, eq(directus_roles.id, directus_users.role))
        .leftJoin(app_user, eq(app_user.directus_user_id, directus_users.id))
        .where(lowerEq(directus_users.email, e))
        .limit(1);
      if (row) return { id: row.id, appId: row.appId, email: e, role: row.role };
      // A Better Auth identity without a Directus row (signed up after cutover).
      const [auth] = await db
        .select({ id: auth_user.id })
        .from(auth_user)
        .where(lowerEq(auth_user.email, e))
        .limit(1);
      return auth ? { id: auth.id, appId: null, email: e, role: null } : null;
    },

    // ── reads for the export ──────────────────────────────────────────

    async account(p: Person) {
      const [directus] = await db.select().from(directus_users).where(eq(directus_users.id, p.id));
      const [auth] = await db
        .select({
          id: auth_user.id,
          name: auth_user.name,
          email: auth_user.email,
          email_verified: auth_user.emailVerified,
          two_factor_enabled: auth_user.twoFactorEnabled,
          created_at: auth_user.createdAt,
          updated_at: auth_user.updatedAt,
        })
        .from(auth_user)
        .where(eq(auth_user.id, p.id));
      const app = p.appId
        ? (await db.select().from(app_user).where(eq(app_user.id, p.appId)))[0]
        : undefined;
      const signIn = await db
        .select({ provider: auth_account.providerId, created_at: auth_account.createdAt })
        .from(auth_account)
        .where(eq(auth_account.userId, p.id))
        .orderBy(asc(auth_account.createdAt));
      const sessions = await db
        .select({
          created_at: auth_session.createdAt,
          expires_at: auth_session.expiresAt,
          ip_address: auth_session.ipAddress,
          user_agent: auth_session.userAgent,
          device_id: auth_session.deviceId,
          last_seen_at: auth_session.lastSeenAt,
        })
        .from(auth_session)
        .where(eq(auth_session.userId, p.id))
        .orderBy(asc(auth_session.createdAt));
      return { directus, auth, app, signIn, sessions };
    },

    async memberships(appId: string | null) {
      if (!appId) return { orgs: [], workspaces: [], projects: [] };
      const orgs = await db
        .select({
          org_id: org_membership.org_id,
          org_name: org.name,
          role: org_membership.role,
          created_at: org_membership.created_at,
          deleted_at: org_membership.deleted_at,
        })
        .from(org_membership)
        .leftJoin(org, eq(org.id, org_membership.org_id))
        .where(eq(org_membership.user_id, appId))
        .orderBy(asc(org_membership.created_at));
      const workspaces = await db
        .select({
          workspace_id: workspace_membership.workspace_id,
          workspace_name: workspace.name,
          role: workspace_membership.role,
          source: workspace_membership.source,
          created_at: workspace_membership.created_at,
          expires_at: workspace_membership.expires_at,
          deleted_at: workspace_membership.deleted_at,
        })
        .from(workspace_membership)
        .leftJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
        .where(eq(workspace_membership.user_id, appId))
        .orderBy(asc(workspace_membership.created_at));
      const projects = await db
        .select({
          project_id: project_membership.project_id,
          project_name: project.name,
          created_at: project_membership.created_at,
        })
        .from(project_membership)
        .leftJoin(project, eq(project.id, project_membership.project_id))
        .where(eq(project_membership.user_id, appId))
        .orderBy(asc(project_membership.created_at));
      return { orgs, workspaces, projects };
    },

    async projectsCreated(id: string) {
      return db
        .select({
          id: project.id,
          name: project.name,
          workspace_id: project.workspace_id,
          language: project.language,
          context: project.context,
          created_at: project.created_at,
          deleted_at: project.deleted_at,
        })
        .from(project)
        .where(eq(project.directus_user_id, id))
        .orderBy(asc(project.created_at));
    },

    /** Conversations in projects they created, and those they took part in under their email. */
    async conversations(projectIds: readonly string[], email: string) {
      const rows = await db
        .select()
        .from(conversation)
        .where(
          or(
            projectIds.length ? inArray(conversation.project_id, [...projectIds]) : sql`false`,
            lowerEq(conversation.participant_email, email),
          ),
        )
        .orderBy(asc(conversation.created_at), asc(conversation.id));
      return rows.map(({ merged_transcript: _t, ...r }) => r);
    },

    async transcript(conversationId: string) {
      const rows = await db
        .select({ at: conversation_chunk.timestamp, text: conversation_chunk.transcript })
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id));
      return rows.filter((r) => r.text);
    },

    async chats(id: string) {
      const chats = await db
        .select()
        .from(project_chat)
        .where(eq(project_chat.user_created, id))
        .orderBy(asc(project_chat.date_created));
      const messages = chats.length
        ? await db
            .select()
            .from(project_chat_message)
            .where(
              inArray(
                project_chat_message.project_chat_id,
                chats.map((c) => c.id),
              ),
            )
            .orderBy(asc(project_chat_message.date_created), asc(project_chat_message.id))
        : [];
      return chats.map((c) => ({
        ...c,
        messages: messages.filter((m) => m.project_chat_id === c.id),
      }));
    },

    /** Signatures they made, and documents naming them as the signer. */
    async documents(p: Person) {
      const signatures = await db
        .select()
        .from(account_signature)
        .where(
          or(eq(account_signature.signerUserId, p.id), lowerEq(account_signature.email, p.email)),
        )
        .orderBy(asc(account_signature.signedAt));
      const ids = signatures.map((s) => s.documentId);
      const documents = await db
        .select({
          id: account_document.id,
          org_id: account_document.orgId,
          kind: account_document.kind,
          title: account_document.title,
          reference: account_document.reference,
          version: account_document.version,
          status: account_document.status,
          sha256: account_document.sha256,
          signer_email: account_document.signerEmail,
          signer_name: account_document.signerName,
          signer_role: account_document.signerRole,
          sent_at: account_document.sentAt,
          signed_at: account_document.signedAt,
          declined_at: account_document.declinedAt,
          decline_reason: account_document.declineReason,
        })
        .from(account_document)
        .where(
          or(
            ids.length ? inArray(account_document.id, ids) : sql`false`,
            lowerEq(account_document.signerEmail, p.email),
          ),
        )
        .orderBy(asc(account_document.createdAt));
      const tickets = await db
        .select()
        .from(account_ticket_message)
        .where(eq(account_ticket_message.authorUserId, p.id))
        .orderBy(asc(account_ticket_message.createdAt));
      return { signatures, documents, tickets };
    },

    async audit(p: Person) {
      const staff = await db
        .select()
        .from(staff_audit_event)
        .where(
          or(
            eq(staff_audit_event.staffUserId, p.id),
            and(eq(staff_audit_event.targetType, "user"), eq(staff_audit_event.targetId, p.id)),
          ),
        )
        .orderBy(asc(staff_audit_event.createdAt));
      const account = await db
        .select()
        .from(account_event)
        .where(eq(account_event.actorUserId, p.id))
        .orderBy(asc(account_event.createdAt));
      const agent = p.appId
        ? await db
            .select()
            .from(agent_audit_event)
            .where(eq(agent_audit_event.app_user_id, p.appId))
            .orderBy(asc(agent_audit_event.created_at))
        : [];
      const support = p.appId
        ? await db
            .select()
            .from(support_access_event)
            .where(
              or(
                eq(support_access_event.actor_user_id, p.appId),
                eq(support_access_event.staff_user_id, p.appId),
              ),
            )
            .orderBy(asc(support_access_event.created_at))
        : [];
      return { staff, account, agent, support };
    },

    async other(p: Person) {
      const ids = [p.id, ...(p.appId ? [p.appId] : [])];
      const notifications = p.appId
        ? await db
            .select()
            .from(notification)
            .where(eq(notification.audience_user_id, p.appId))
            .orderBy(asc(notification.created_at))
        : [];
      const grants = await db
        .select({
          id: agent_grant.id,
          client_name: agent_grant.client_name,
          scopes: agent_grant.scopes,
          org_ids: agent_grant.org_ids,
          created_at: agent_grant.created_at,
          last_used_at: agent_grant.last_used_at,
          revoked_at: agent_grant.revoked_at,
        })
        .from(agent_grant)
        .where(this.grantsOf(p))
        .orderBy(asc(agent_grant.created_at));
      const memories = await db
        .select()
        .from(agent_memory)
        .where(eq(agent_memory.directus_user_id, p.id))
        .orderBy(asc(agent_memory.created_at));
      const feedback = await db
        .select()
        .from(model_response_feedback)
        .where(eq(model_response_feedback.user_id, p.id))
        .orderBy(asc(model_response_feedback.date_created));
      const supportRequests = await db
        .select()
        .from(support_request)
        .where(
          or(
            inArray(support_request.directus_user_id, ids),
            inArray(support_request.app_user_id, ids),
          ),
        )
        .orderBy(asc(support_request.created_at));
      const pricing = await db
        .select()
        .from(pricing_configuration)
        .where(
          or(
            inArray(pricing_configuration.user_id, ids),
            lowerEq(pricing_configuration.email, p.email),
          ),
        )
        .orderBy(asc(pricing_configuration.created_at));
      const orgInvites = await db
        .select()
        .from(org_invite)
        .where(lowerEq(org_invite.email, p.email))
        .orderBy(asc(org_invite.created_at));
      const workspaceInvites = await db
        .select()
        .from(workspace_invite)
        .where(lowerEq(workspace_invite.email, p.email))
        .orderBy(asc(workspace_invite.created_at));
      return {
        notifications,
        grants,
        memories,
        feedback,
        supportRequests,
        pricing,
        invites: { orgs: orgInvites, workspaces: workspaceInvites },
      };
    },

    grantsOf(p: Person) {
      return or(
        eq(agent_grant.directus_user_id, p.id),
        p.appId ? eq(agent_grant.app_user_id, p.appId) : sql`false`,
      );
    },

    /** Storage keys of the exports made for this person, from the audit rows that made them. */
    async exportKeys(id: string): Promise<string[]> {
      const rows = await db
        .select({ detail: staff_audit_event.detail })
        .from(staff_audit_event)
        .where(
          and(
            eq(staff_audit_event.action, "person.export"),
            eq(staff_audit_event.targetType, "user"),
            eq(staff_audit_event.targetId, id),
          ),
        );
      return rows
        .map((r) => (r.detail as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === "string");
    },

    // ── the erasure plan ──────────────────────────────────────────────

    /** Live organisations where they are the only owner or admin. */
    async soleAdminOrgs(appId: string | null) {
      if (!appId) return [];
      const rows = await db.execute<{ id: string; name: string | null }>(sql`
        select o.id, o.name from org o
        join org_membership m on m.org_id = o.id and m.user_id = ${appId}
          and m.deleted_at is null and m.role in ('owner', 'admin')
        where o.deleted_at is null and not exists (
          select 1 from org_membership x
          where x.org_id = o.id and x.user_id <> ${appId} and x.deleted_at is null
            and x.role in ('owner', 'admin'))
        order by o.id`);
      return [...rows];
    },

    async count(p: Person) {
      const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const c = sql<number>`count(*)::int`;
      const projects = await this.projectsCreated(p.id);
      return {
        memberships: p.appId
          ? (await n(
              db.select({ n: c }).from(org_membership).where(eq(org_membership.user_id, p.appId)),
            )) +
            (await n(
              db
                .select({ n: c })
                .from(workspace_membership)
                .where(eq(workspace_membership.user_id, p.appId)),
            )) +
            (await n(
              db
                .select({ n: c })
                .from(project_membership)
                .where(eq(project_membership.user_id, p.appId)),
            ))
          : 0,
        private_chats: await n(
          db
            .select({ n: c })
            .from(project_chat)
            .where(and(eq(project_chat.user_created, p.id), eq(project_chat.is_private, true))),
        ),
        shared_chats: await n(
          db
            .select({ n: c })
            .from(project_chat)
            .where(
              and(
                eq(project_chat.user_created, p.id),
                or(isNull(project_chat.is_private), eq(project_chat.is_private, false)),
              ),
            ),
        ),
        agent_grants: await n(db.select({ n: c }).from(agent_grant).where(this.grantsOf(p))),
        signatures: await n(
          db
            .select({ n: c })
            .from(account_signature)
            .where(
              or(
                eq(account_signature.signerUserId, p.id),
                lowerEq(account_signature.email, p.email),
              ),
            ),
        ),
        projects_created: projects.length,
        participant_conversations: await n(
          db
            .select({ n: c })
            .from(conversation)
            .where(lowerEq(conversation.participant_email, p.email)),
        ),
      };
    },

    // ── the erasure ───────────────────────────────────────────────────

    /**
     * Removes the person in one transaction and returns the file keys to delete once it
     * commits. Kept: signatures and the documents they bind (insert-only legal evidence),
     * audit trails (they keep only the id, which no longer resolves), and everything the
     * person made inside an organisation's workspaces, which is that organisation's data.
     */
    async erase(p: Person): Promise<{ files: string[] }> {
      return db.transaction(async (tx) => {
        const [me] = await tx
          .select({ avatar: directus_users.avatar, logo: directus_users.whitelabel_logo })
          .from(directus_users)
          .where(eq(directus_users.id, p.id));
        const fileIds = [me?.avatar, me?.logo].filter((x): x is string => Boolean(x));

        await tx.delete(announcement_activity).where(eq(announcement_activity.user_id, p.id));
        await tx
          .delete(project_chat)
          .where(and(eq(project_chat.user_created, p.id), eq(project_chat.is_private, true)));
        for (const [table, column] of AUTHOR_COLUMNS)
          await tx.execute(
            sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = null where ${sql.identifier(column)} = ${p.id}`,
          );

        const grants = await tx
          .select({ id: agent_grant.id })
          .from(agent_grant)
          .where(this.grantsOf(p));
        if (grants.length) {
          const gids = grants.map((g) => g.id);
          await tx.delete(agent_token).where(inArray(agent_token.grant_id, gids));
          await tx.delete(agent_grant).where(inArray(agent_grant.id, gids));
        }
        await tx.delete(agent_memory).where(eq(agent_memory.directus_user_id, p.id));

        const ids = [p.id, ...(p.appId ? [p.appId] : [])];
        await tx
          .delete(usage_insight)
          .where(
            or(
              inArray(usage_insight.directus_user_id, ids),
              inArray(usage_insight.app_user_id, ids),
            ),
          );
        await tx
          .delete(support_request)
          .where(
            or(
              inArray(support_request.directus_user_id, ids),
              inArray(support_request.app_user_id, ids),
            ),
          );
        await tx
          .delete(pricing_configuration)
          .where(
            or(
              inArray(pricing_configuration.user_id, ids),
              lowerEq(pricing_configuration.email, p.email),
            ),
          );
        await tx.delete(org_invite).where(lowerEq(org_invite.email, p.email));
        await tx.delete(workspace_invite).where(lowerEq(workspace_invite.email, p.email));
        await tx
          .delete(project_report_notification_participants)
          .where(lowerEq(project_report_notification_participants.email, p.email));
        await tx.delete(auth_verification).where(lowerEq(auth_verification.identifier, p.email));

        // Memberships, notifications, licences and access requests go with the app_user
        // (ON DELETE CASCADE); sessions, sign-in methods and 2FA with the auth_user.
        if (p.appId) await tx.delete(app_user).where(eq(app_user.id, p.appId));
        await tx.delete(auth_user).where(eq(auth_user.id, p.id));
        await tx.delete(directus_users).where(eq(directus_users.id, p.id));

        const files = fileIds.length
          ? await tx
              .delete(directus_files)
              .where(inArray(directus_files.id, fileIds))
              .returning({ key: directus_files.filename_disk })
          : [];
        return { files: files.map((f) => f.key).filter((k): k is string => Boolean(k)) };
      });
    },
  };
}

export type PrivacyStorage = ReturnType<typeof privacyStorage>;
