import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { directusRow } from "@dembrane/legacy-shape";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

const {
  project,
  project_tag,
  conversation,
  conversation_chunk,
  conversation_project_tag,
  project_report,
  project_report_metric,
  project_report_notification_participants,
  processing_status,
  project_chat,
  verification_topic,
  verification_topic_translations,
  scheduled_task,
  workspace,
  billing_account,
  workspace_membership,
  org_membership,
  org,
  app_user,
  directus_users,
  notification,
  project_goal_revision,
  methodology,
  methodology_version,
  prompt_template,
} = schema;

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids arrive from paths and bodies; one that is not a uuid names nothing, like a missing row. */
export const isUuid = (id: string) => UUID.test(id);

/** Directus rows carried their one-to-many relations as id lists, sorted by the related key. */
async function projectAliases(db: Db, id: string): Promise<Row> {
  const [convs, topics, statuses, reports, chats, tags] = await Promise.all([
    db
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.project_id, id))
      .orderBy(asc(conversation.id)),
    db
      .select({ id: verification_topic.key })
      .from(verification_topic)
      .where(eq(verification_topic.project_id, id))
      .orderBy(asc(verification_topic.key)),
    db
      .select({ id: processing_status.id })
      .from(processing_status)
      .where(eq(processing_status.project_id, id))
      .orderBy(asc(processing_status.id)),
    db
      .select({ id: project_report.id })
      .from(project_report)
      .where(eq(project_report.project_id, id))
      .orderBy(asc(project_report.id)),
    db
      .select({ id: project_chat.id })
      .from(project_chat)
      .where(eq(project_chat.project_id, id))
      .orderBy(asc(project_chat.id)),
    db
      .select({ id: project_tag.id })
      .from(project_tag)
      .where(eq(project_tag.project_id, id))
      .orderBy(asc(project_tag.id)),
  ]);
  const ids = (rows: { id: unknown }[]) => rows.map((r) => String(r.id));
  return {
    conversations: ids(convs),
    custom_verification_topics: ids(topics),
    processing_status: ids(statuses),
    project_reports: ids(reports),
    project_chats: ids(chats),
    tags: ids(tags),
  };
}

/** A database handle plus the raw transaction, so jobs can be enqueued in the same commit. */
export interface Tx {
  readonly store: ProjectsStorage;
  readonly sql: postgres.TransactionSql;
}

export function projectsStorage(db: Db) {
  const self = {
    /** Runs fn in one transaction; the job queue writes through `sql` so a job exists only if the write commits. */
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client = (db as unknown as { $client: postgres.Sql }).$client;
      return (await client.begin(async (txSql) => {
        // Drizzle reads the parser options off its client; a transaction handle has none of
        // its own, so it borrows the pool's (already set up for string timestamps).
        const bound = Object.assign(txSql, { options: client.options }) as unknown as postgres.Sql;
        const txDb = drizzle(bound, { schema }) as unknown as Db;
        return fn({ store: projectsStorage(txDb), sql: txSql });
      })) as T;
    },

    // ── projects ──────────────────────────────────────────────────────

    async project(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(project).where(eq(project.id, id)).limit(1);
      return row ?? null;
    },

    /** The project as Directus get_item returned it: every column plus relation id lists. */
    async projectItem(id: string): Promise<Row | null> {
      const row = await self.project(id);
      if (!row) return null;
      return { ...directusRow(row), ...(await projectAliases(db, id)) };
    },

    async updateProject(id: string, values: Partial<typeof project.$inferInsert>) {
      await db.update(project).set(values).where(eq(project.id, id));
    },

    async insertProject(values: typeof project.$inferInsert) {
      await db.insert(project).values(values);
    },

    async projectsInWorkspaces(
      workspaceIds: string[],
      opts: { search: string | null; limit: number; offset: number },
    ) {
      const filters: SQL[] = [
        inArray(project.workspace_id, workspaceIds),
        isNull(project.deleted_at),
      ];
      // Every whitespace token must appear in the name, in any order, case-insensitive.
      for (const token of (opts.search ?? "").split(/\s+/).filter(Boolean))
        filters.push(ilike(project.name, `%${escapeLike(token)}%`));
      const rows = await db
        .select({
          id: project.id,
          name: project.name,
          workspace_id: project.workspace_id,
          visibility: project.visibility,
          language: project.language,
          updated_at: project.updated_at,
          directus_user_id: project.directus_user_id,
        })
        .from(project)
        .where(and(...filters))
        .orderBy(desc(project.updated_at), asc(project.id))
        .limit(opts.limit)
        .offset(opts.offset);
      return rows.map(directusRow);
    },

    // ── verify topics ─────────────────────────────────────────────────

    /** The project's own verify topics with their labels. */
    async customTopics(projectId: string) {
      const topics = await db
        .select()
        .from(verification_topic)
        .where(eq(verification_topic.project_id, projectId))
        .orderBy(asc(verification_topic.key));
      if (!topics.length) return [];
      const labels = await db
        .select()
        .from(verification_topic_translations)
        .where(
          inArray(
            verification_topic_translations.verification_topic_key,
            topics.map((t) => t.key),
          ),
        )
        .orderBy(asc(verification_topic_translations.id));
      return topics.map((t) => ({
        topic: t,
        labels: labels.filter((l) => l.verification_topic_key === t.key),
      }));
    },

    async insertCustomTopic(
      topic: typeof verification_topic.$inferInsert,
      labels: { languages_code: string | null; label: string | null }[],
    ) {
      await db.insert(verification_topic).values(topic);
      if (labels.length)
        await db
          .insert(verification_topic_translations)
          .values(labels.map((l) => ({ ...l, verification_topic_key: topic.key })));
    },

    // ── tags ──────────────────────────────────────────────────────────

    async tags(projectId: string) {
      const rows = await db
        .select({
          id: project_tag.id,
          created_at: project_tag.created_at,
          text: project_tag.text,
          sort: project_tag.sort,
        })
        .from(project_tag)
        .where(eq(project_tag.project_id, projectId))
        .orderBy(sql`${project_tag.sort} asc nulls last`, asc(project_tag.id));
      return rows.map(directusRow);
    },

    async tag(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(project_tag).where(eq(project_tag.id, id)).limit(1);
      return row ?? null;
    },

    async insertTags(rows: (typeof project_tag.$inferInsert)[]) {
      if (rows.length) await db.insert(project_tag).values(rows);
    },

    async updateTag(id: string, values: Partial<typeof project_tag.$inferInsert>) {
      await db.update(project_tag).set(values).where(eq(project_tag.id, id));
    },

    async deleteTag(id: string) {
      await db.delete(project_tag).where(eq(project_tag.id, id));
    },

    async tagLinkIds(tagId: string) {
      const rows = await db
        .select({ id: conversation_project_tag.id })
        .from(conversation_project_tag)
        .where(eq(conversation_project_tag.project_tag_id, tagId))
        .orderBy(asc(conversation_project_tag.id));
      return rows.map((r) => r.id);
    },

    async deleteTagLinks(tagId: string) {
      await db
        .delete(conversation_project_tag)
        .where(eq(conversation_project_tag.project_tag_id, tagId));
    },

    // ── conversations ─────────────────────────────────────────────────

    /** Live conversations with their chunks in timestamp order, as the transcript export reads them. */
    async conversationsWithChunks(projectId: string) {
      const convs = await db
        .select({
          id: conversation.id,
          created_at: conversation.created_at,
          participant_name: conversation.participant_name,
          participant_email: conversation.participant_email,
        })
        .from(conversation)
        .where(and(eq(conversation.project_id, projectId), isNull(conversation.deleted_at)))
        .orderBy(desc(conversation.created_at), asc(conversation.id));
      if (!convs.length) return [];
      const chunks = await db
        .select({
          conversation_id: conversation_chunk.conversation_id,
          transcript: conversation_chunk.transcript,
        })
        .from(conversation_chunk)
        .where(
          inArray(
            conversation_chunk.conversation_id,
            convs.map((c) => c.id),
          ),
        )
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id));
      return convs.map((c) => ({
        ...c,
        chunks: chunks.filter((k) => k.conversation_id === c.id).map((k) => k.transcript),
      }));
    },

    async conversationUsage(projectId: string) {
      return db
        .select({
          id: conversation.id,
          title: conversation.title,
          duration: conversation.duration,
          deleted_at: conversation.deleted_at,
        })
        .from(conversation)
        .where(eq(conversation.project_id, projectId))
        .orderBy(asc(conversation.id));
    },

    async latestConversationCreatedAt(projectId: string) {
      const [row] = await db
        .select({ created_at: conversation.created_at })
        .from(conversation)
        .where(and(eq(conversation.project_id, projectId), isNull(conversation.deleted_at)))
        .orderBy(desc(conversation.created_at))
        .limit(1);
      return row ? row.created_at : undefined;
    },

    // ── reports ───────────────────────────────────────────────────────

    async reportsForList(projectId: string) {
      return db
        .select({
          id: project_report.id,
          status: project_report.status,
          date_created: project_report.date_created,
          language: project_report.language,
          user_instructions: project_report.user_instructions,
          content: project_report.content,
          scheduled_at: project_report.scheduled_at,
        })
        .from(project_report)
        .where(
          and(
            eq(project_report.project_id, projectId),
            eq(project_report.kind, "report"),
            inArray(project_report.status, ["archived", "published", "scheduled", "draft"]),
            isNull(project_report.deleted_at),
          ),
        )
        .orderBy(desc(project_report.date_created), asc(project_report.id));
    },

    async latestReport(projectId: string) {
      const [row] = await db
        .select({
          id: project_report.id,
          status: project_report.status,
          project_id: project_report.project_id,
          show_portal_link: project_report.show_portal_link,
          date_created: project_report.date_created,
          error_message: project_report.error_message,
          content: project_report.content,
        })
        .from(project_report)
        .where(
          and(
            eq(project_report.project_id, projectId),
            eq(project_report.kind, "report"),
            isNull(project_report.deleted_at),
          ),
        )
        .orderBy(desc(project_report.date_created), asc(project_report.id))
        .limit(1);
      return row ?? null;
    },

    async report(id: bigint) {
      const [row] = await db
        .select()
        .from(project_report)
        .where(eq(project_report.id, id))
        .limit(1);
      return row ?? null;
    },

    /** A report of this project, or null: report ids are sequential and must never cross projects. */
    async reportInProject(id: bigint, projectId: string) {
      const [row] = await db
        .select()
        .from(project_report)
        .where(and(eq(project_report.id, id), eq(project_report.project_id, projectId)))
        .limit(1);
      return row ?? null;
    },

    async hasDraftReport(projectId: string) {
      const [row] = await db
        .select({ id: project_report.id })
        .from(project_report)
        .where(
          and(
            eq(project_report.project_id, projectId),
            eq(project_report.kind, "report"),
            eq(project_report.status, "draft"),
            isNull(project_report.deleted_at),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    /** The free tier's report count: a sample copy's reports are not the workspace's own. */
    async countWorkspaceReports(workspaceId: string) {
      const [row] = await db
        .select({ n: count(project_report.id) })
        .from(project_report)
        .innerJoin(project, eq(project.id, project_report.project_id))
        .where(
          and(
            eq(project.workspace_id, workspaceId),
            eq(project.is_sample, false),
            isNull(project_report.deleted_at),
            eq(project_report.kind, "report"),
          ),
        );
      return row?.n ?? 0;
    },

    async insertReport(values: typeof project_report.$inferInsert) {
      const [row] = await db.insert(project_report).values(values).returning();
      if (!row) throw new Error("report insert returned nothing");
      return row;
    },

    async updateReport(id: bigint, values: Partial<typeof project_report.$inferInsert>) {
      const [row] = await db
        .update(project_report)
        .set(values)
        .where(eq(project_report.id, id))
        .returning();
      return row ?? null;
    },

    async otherPublishedReports(projectId: string, exceptId: bigint) {
      const rows = await db
        .select({ id: project_report.id })
        .from(project_report)
        .where(
          and(
            eq(project_report.project_id, projectId),
            eq(project_report.kind, "report"),
            eq(project_report.status, "published"),
            ne(project_report.id, exceptId),
            isNull(project_report.deleted_at),
          ),
        )
        .orderBy(asc(project_report.id));
      return rows.map((r) => r.id);
    },

    async reportViews(reportId: bigint, since: string) {
      const [all] = await db
        .select({ n: count() })
        .from(project_report_metric)
        .where(eq(project_report_metric.project_report_id, Number(reportId)));
      const [recent] = await db
        .select({ n: count() })
        .from(project_report_metric)
        .where(
          and(
            eq(project_report_metric.project_report_id, Number(reportId)),
            gte(project_report_metric.date_created, since),
          ),
        );
      return { total: all?.n ?? 0, recent: recent?.n ?? 0 };
    },

    async optedInParticipants(projectId: string) {
      const [row] = await db
        .select({ n: count() })
        .from(project_report_notification_participants)
        .where(
          and(
            eq(project_report_notification_participants.project_id, projectId),
            eq(project_report_notification_participants.email_opt_in, true),
          ),
        );
      return row?.n ?? 0;
    },

    // ── scheduled tasks (the durable one-shot table the scheduler runner drains) ──

    async scheduleTask(values: typeof scheduled_task.$inferInsert) {
      await db.insert(scheduled_task).values(values);
    },

    /** Cancels still-scheduled tasks of a type whose JSON payload holds every given key and value; ids match as string or number. */
    async cancelScheduledTasks(taskType: string, match: Record<string, unknown>, now: string) {
      const rows = await db
        .select({ id: scheduled_task.id, payload: scheduled_task.payload })
        .from(scheduled_task)
        .where(and(eq(scheduled_task.task_type, taskType), eq(scheduled_task.status, "scheduled")));
      let n = 0;
      for (const r of rows) {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        if (
          Object.entries(match).every(
            ([k, v]) => payload[k] != null && String(payload[k]) === String(v),
          )
        ) {
          await db
            .update(scheduled_task)
            .set({ status: "cancelled", updated_at: now })
            .where(eq(scheduled_task.id, r.id));
          n++;
        }
      }
      return n;
    },

    // ── goals and methodologies ───────────────────────────────────────

    async goalRevisions(projectId: string) {
      const rows = await db
        .select({
          id: project_goal_revision.id,
          content: project_goal_revision.content,
          set_by: project_goal_revision.set_by,
          created_at: project_goal_revision.created_at,
        })
        .from(project_goal_revision)
        .where(eq(project_goal_revision.project_id, projectId))
        .orderBy(desc(project_goal_revision.created_at), asc(project_goal_revision.id))
        .limit(100);
      return rows.map(directusRow);
    },

    async insertGoalRevision(values: typeof project_goal_revision.$inferInsert) {
      const [row] = await db.insert(project_goal_revision).values(values).returning();
      return row ? directusRow(row) : {};
    },

    async chatInProject(chatId: string, projectId: string) {
      if (!isUuid(chatId)) return false;
      const [row] = await db
        .select({ id: project_chat.id })
        .from(project_chat)
        .where(
          and(
            eq(project_chat.id, chatId),
            eq(project_chat.project_id, projectId),
            isNull(project_chat.deleted_at),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async methodology(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(methodology).where(eq(methodology.id, id)).limit(1);
      return row ?? null;
    },

    async visibleMethodologies(workspaceId: string, directusUserId: string) {
      if (!isUuid(workspaceId)) return [];
      return db
        .select()
        .from(methodology)
        .where(
          or(
            eq(methodology.visibility, "public"),
            and(eq(methodology.visibility, "workspace"), eq(methodology.workspace_id, workspaceId)),
            eq(methodology.owner_directus_user_id, directusUserId),
          ),
        )
        .orderBy(
          sql`${methodology.is_seeded} asc nulls last`,
          sql`${methodology.name} asc nulls last`,
          asc(methodology.id),
        );
    },

    async methodologyVersions(methodologyId: string) {
      const rows = await db
        .select({
          id: methodology_version.id,
          note: methodology_version.note,
          created_by: methodology_version.created_by,
          created_at: methodology_version.created_at,
          content: methodology_version.content,
        })
        .from(methodology_version)
        .where(eq(methodology_version.methodology_id, methodologyId))
        .orderBy(desc(methodology_version.created_at), asc(methodology_version.id));
      return rows.map(directusRow);
    },

    async insertMethodology(values: typeof methodology.$inferInsert) {
      const [row] = await db.insert(methodology).values(values).returning();
      return row ? directusRow(row) : null;
    },

    async updateMethodology(id: string, values: Partial<typeof methodology.$inferInsert>) {
      const [row] = await db
        .update(methodology)
        .set(values)
        .where(eq(methodology.id, id))
        .returning();
      return row ? directusRow(row) : null;
    },

    async insertMethodologyVersion(values: typeof methodology_version.$inferInsert) {
      const [row] = await db.insert(methodology_version).values(values).returning();
      return row ? directusRow(row) : null;
    },

    // ── prompt templates and user preferences ─────────────────────────

    async personalTemplates(directusUserId: string) {
      return db
        .select({ t: prompt_template, firstName: directus_users.first_name })
        .from(prompt_template)
        .leftJoin(directus_users, eq(directus_users.id, prompt_template.user_created))
        .where(
          and(eq(prompt_template.user_created, directusUserId), eq(prompt_template.scope, "user")),
        )
        .orderBy(sql`${prompt_template.sort} asc nulls last`, asc(prompt_template.id));
    },

    async workspaceTemplates(workspaceId: string) {
      if (!isUuid(workspaceId)) return [];
      return db
        .select({ t: prompt_template, firstName: directus_users.first_name })
        .from(prompt_template)
        .leftJoin(directus_users, eq(directus_users.id, prompt_template.user_created))
        .where(
          and(
            eq(prompt_template.workspace_id, workspaceId),
            eq(prompt_template.scope, "workspace"),
          ),
        )
        .orderBy(sql`${prompt_template.sort} asc nulls last`, asc(prompt_template.id));
    },

    async template(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(prompt_template)
        .where(eq(prompt_template.id, id))
        .limit(1);
      return row ?? null;
    },

    async insertTemplate(values: typeof prompt_template.$inferInsert) {
      const [row] = await db.insert(prompt_template).values(values).returning();
      if (!row) throw new Error("template insert returned nothing");
      return row;
    },

    async updateTemplate(id: string, values: Partial<typeof prompt_template.$inferInsert>) {
      const [row] = await db
        .update(prompt_template)
        .set(values)
        .where(eq(prompt_template.id, id))
        .returning();
      return row ?? null;
    },

    async deleteTemplate(id: string) {
      await db.delete(prompt_template).where(eq(prompt_template.id, id));
    },

    async userPreferences(directusUserId: string) {
      const [row] = await db
        .select({ quick: directus_users.quick_access_preferences })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId))
        .limit(1);
      return row ?? null;
    },

    async updateUserPreferences(
      directusUserId: string,
      values: Partial<typeof directus_users.$inferInsert>,
    ) {
      await db.update(directus_users).set(values).where(eq(directus_users.id, directusUserId));
    },

    async workspaceExists(id: string) {
      if (!isUuid(id)) return false;
      const [row] = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(and(eq(workspace.id, id), isNull(workspace.deleted_at)))
        .limit(1);
      return Boolean(row);
    },

    // ── workspaces, orgs, users ───────────────────────────────────────

    async workspace(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1);
      return row ?? null;
    },

    async liveWorkspace(id: string) {
      const row = await self.workspace(id);
      return row && !row.deleted_at ? row : null;
    },

    async workspaceTier(id: string) {
      const [row] = await db
        .select({ tier: billing_account.tier })
        .from(workspace)
        .innerJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
        .where(eq(workspace.id, id))
        .limit(1);
      return row?.tier ?? null;
    },

    async billingAccountForWorkspace(id: string) {
      const [row] = await db
        .select({ id: billing_account.id, orgId: billing_account.org_id })
        .from(workspace)
        .innerJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
        .where(eq(workspace.id, id))
        .limit(1);
      return row ?? null;
    },

    async org(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(org).where(eq(org.id, id)).limit(1);
      return row ?? null;
    },

    async appUser(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(app_user).where(eq(app_user.id, id)).limit(1);
      return row ?? null;
    },

    async directusUser(id: string) {
      const [row] = await db
        .select({
          email: directus_users.email,
          legal_basis: directus_users.legal_basis,
          privacy_policy_url: directus_users.privacy_policy_url,
          whitelabel_logo: directus_users.whitelabel_logo,
        })
        .from(directus_users)
        .where(eq(directus_users.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Workspaces a user holds a direct row in, plus every live workspace of orgs they administer. */
    async reachableWorkspaceIds(appUserId: string) {
      const direct = await db
        .select({ id: workspace_membership.workspace_id })
        .from(workspace_membership)
        .where(
          and(eq(workspace_membership.user_id, appUserId), isNull(workspace_membership.deleted_at)),
        )
        .orderBy(asc(workspace_membership.id));
      const orgs = await db
        .select({ id: org_membership.org_id })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.user_id, appUserId),
            isNull(org_membership.deleted_at),
            inArray(org_membership.role, ["admin", "owner"]),
          ),
        );
      const ids = direct.map((r) => r.id);
      if (orgs.length) {
        const derived = await db
          .select({ id: workspace.id })
          .from(workspace)
          .where(
            and(
              inArray(
                workspace.org_id,
                orgs.map((o) => o.id),
              ),
              isNull(workspace.deleted_at),
            ),
          )
          .orderBy(asc(workspace.id));
        for (const d of derived) if (!ids.includes(d.id)) ids.push(d.id);
      }
      return ids;
    },

    /**
     * Everyone with access to a workspace (spec 2.3): direct rows other than support staff,
     * then org owners everywhere, org admins on open workspaces, org members only with the
     * legacy inherit flag; sticky removals skip derivation.
     */
    async effectiveMemberIds(workspaceId: string) {
      const ws = await self.liveWorkspace(workspaceId);
      if (!ws) return [];
      const direct = await db
        .select({ user_id: workspace_membership.user_id })
        .from(workspace_membership)
        .where(
          and(
            eq(workspace_membership.workspace_id, workspaceId),
            isNull(workspace_membership.deleted_at),
            ne(workspace_membership.source, "staff_support"),
          ),
        )
        .orderBy(asc(workspace_membership.id));
      const out = direct.map((r) => r.user_id);
      const settings = (ws.settings ?? {}) as {
        inherit_organisation_members?: unknown;
        sticky_removed?: unknown;
      };
      const roles = ["owner"];
      if (ws.visibility === "open_to_organisation") {
        roles.push("admin");
        if (settings.inherit_organisation_members === true) roles.push("member");
      }
      const sticky = new Set(
        (Array.isArray(settings.sticky_removed) ? settings.sticky_removed : []).map((t) =>
          t && typeof t === "object" ? String((t as { user_id?: unknown }).user_id) : String(t),
        ),
      );
      const derived = await db
        .select({ user_id: org_membership.user_id })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.org_id, ws.org_id),
            inArray(org_membership.role, roles),
            isNull(org_membership.deleted_at),
          ),
        )
        .orderBy(asc(org_membership.id));
      for (const d of derived)
        if (!out.includes(d.user_id) && !sticky.has(d.user_id)) out.push(d.user_id);
      return out;
    },

    async insertNotifications(rows: (typeof notification.$inferInsert)[]) {
      if (rows.length) await db.insert(notification).values(rows);
    },

    /** Directus rows for a project's workspace and org, for the legal basis cascade. */
    async legalCascade(workspaceId: string | null, ownerDirectusId: string | null) {
      let ws: typeof workspace.$inferSelect | null = null;
      let orgRow: typeof org.$inferSelect | null = null;
      if (workspaceId) {
        ws = await self.liveWorkspace(workspaceId);
        if (ws) {
          const o = await self.org(ws.org_id);
          orgRow = o && !o.deleted_at ? o : null;
        }
      }
      const owner =
        ownerDirectusId && !(ws?.legal_basis && ws?.logo_url)
          ? await self.directusUser(ownerDirectusId)
          : null;
      return { workspace: ws, org: orgRow, owner };
    },
  };
  return self;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export type ProjectsStorage = ReturnType<typeof projectsStorage>;
