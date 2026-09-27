import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { directusRow } from "@echo/legacy-shape";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

const { project_webhook, project, conversation, conversation_chunk, conversation_project_tag } =
  schema;
const { project_tag, project_report, project_report_notification_participants } = schema;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookRow = typeof project_webhook.$inferSelect;

export function webhooksStorage(db: Db) {
  return {
    async forProject(projectId: string) {
      return db
        .select()
        .from(project_webhook)
        .where(and(eq(project_webhook.project_id, projectId), isNull(project_webhook.deleted_at)))
        .orderBy(desc(project_webhook.date_created), asc(project_webhook.id));
    },

    /** Published webhooks of every other project, with the project's name, for the copy picker. */
    async copyable(exceptProjectId: string) {
      return db
        .select({ w: project_webhook, projectName: project.name, projectId: project.id })
        .from(project_webhook)
        .innerJoin(project, eq(project.id, project_webhook.project_id))
        .where(
          and(
            ne(project_webhook.project_id, exceptProjectId),
            eq(project_webhook.status, "published"),
            isNull(project_webhook.deleted_at),
          ),
        )
        .orderBy(
          sql`${project.name} asc nulls last`,
          sql`${project_webhook.name} asc nulls last`,
          asc(project_webhook.id),
        );
    },

    /** A webhook of this project, deleted or not, as the Python lookups did. */
    async inProject(webhookId: string, projectId: string) {
      if (!UUID.test(webhookId)) return null;
      const [row] = await db
        .select()
        .from(project_webhook)
        .where(and(eq(project_webhook.id, webhookId), eq(project_webhook.project_id, projectId)))
        .limit(1);
      return row ?? null;
    },

    async get(webhookId: string) {
      if (!UUID.test(webhookId)) return null;
      const [row] = await db
        .select()
        .from(project_webhook)
        .where(eq(project_webhook.id, webhookId))
        .limit(1);
      return row ?? null;
    },

    async insert(values: typeof project_webhook.$inferInsert) {
      const [row] = await db.insert(project_webhook).values(values).returning();
      if (!row) throw new Error("webhook insert returned nothing");
      return row;
    },

    async update(webhookId: string, values: Partial<typeof project_webhook.$inferInsert>) {
      const [row] = await db
        .update(project_webhook)
        .set(values)
        .where(eq(project_webhook.id, webhookId))
        .returning();
      return row ?? null;
    },

    async publishedForProject(projectId: string) {
      return db
        .select()
        .from(project_webhook)
        .where(
          and(
            eq(project_webhook.project_id, projectId),
            eq(project_webhook.status, "published"),
            isNull(project_webhook.deleted_at),
          ),
        )
        .orderBy(asc(project_webhook.id));
    },

    async project(projectId: string) {
      if (!UUID.test(projectId)) return null;
      const [row] = await db
        .select()
        .from(project)
        .where(and(eq(project.id, projectId), isNull(project.deleted_at)))
        .limit(1);
      return row ?? null;
    },

    async conversation(conversationId: string) {
      if (!UUID.test(conversationId)) return null;
      const [row] = await db
        .select()
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), isNull(conversation.deleted_at)))
        .limit(1);
      if (!row) return null;
      const tags = await db
        .select({ text: project_tag.text, tagId: project_tag.id })
        .from(conversation_project_tag)
        .leftJoin(project_tag, eq(project_tag.id, conversation_project_tag.project_tag_id))
        .where(eq(conversation_project_tag.conversation_id, conversationId))
        .orderBy(asc(conversation_project_tag.id));
      // Timestamps as Directus printed them, which is what receivers have always parsed.
      return { ...(directusRow(row) as typeof row), tags };
    },

    /** The transcript as receivers get it: chunk texts in time order, trimmed, one per line. */
    async transcript(conversationId: string) {
      const rows = await db
        .select({ transcript: conversation_chunk.transcript })
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
        .limit(2000);
      return rows
        .map((r) => r.transcript?.trim())
        .filter(Boolean)
        .join("\n");
    },

    async emails(conversationId: string) {
      const rows = await db
        .select({ email: project_report_notification_participants.email })
        .from(project_report_notification_participants)
        .where(eq(project_report_notification_participants.conversation_id, conversationId))
        .orderBy(asc(project_report_notification_participants.id))
        .limit(1000);
      return rows
        .map((r) => r.email)
        .filter(Boolean)
        .join(",");
    },

    async report(reportId: bigint) {
      const [row] = await db
        .select()
        .from(project_report)
        .where(eq(project_report.id, reportId))
        .limit(1);
      return row ?? null;
    },
  };
}

export type WebhooksStorage = ReturnType<typeof webhooksStorage>;
