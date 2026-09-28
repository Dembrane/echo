import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import { isUuid } from "../storage";

const {
  project,
  project_report,
  project_report_metric,
  project_report_notification_participants: subscribers,
  conversation,
} = schema;

/**
 * A published report the portal may show: kind report (a canvas is also a published
 * project_report row and must not shadow it), status published, and neither the report
 * nor its project soft-deleted (L-21: the Python API served reports of deleted projects).
 */
function publishedIn(projectId: string) {
  return and(
    eq(project_report.project_id, projectId),
    eq(project_report.kind, "report"),
    eq(project_report.status, "published"),
    isNull(project_report.deleted_at),
    isNull(project.deleted_at),
  );
}

export function reportsStorage(db: Db) {
  return {
    async latestPublished(projectId: string) {
      if (!isUuid(projectId)) return null;
      const [row] = await db
        .select({
          id: project_report.id,
          status: project_report.status,
          project_id: project_report.project_id,
          show_portal_link: project_report.show_portal_link,
        })
        .from(project_report)
        .innerJoin(project, eq(project.id, project_report.project_id))
        .where(publishedIn(projectId))
        // Directus broke ties on the primary key.
        .orderBy(desc(project_report.date_created), desc(project_report.id))
        .limit(1);
      return row ?? null;
    },

    async publishedDetail(projectId: string, reportId: number) {
      if (!isUuid(projectId)) return null;
      const [row] = await db
        .select({
          id: project_report.id,
          content: project_report.content,
          status: project_report.status,
          project_id: project_report.project_id,
          show_portal_link: project_report.show_portal_link,
        })
        .from(project_report)
        .innerJoin(project, eq(project.id, project_report.project_id))
        .where(and(eq(project_report.id, BigInt(reportId)), publishedIn(projectId)))
        .limit(1);
      return row ?? null;
    },

    /** Metrics of any report in the project since `since`, as the portal's live counter reads them. */
    async recentViews(projectId: string, since: Date): Promise<number> {
      if (!isUuid(projectId)) return 0;
      const [row] = await db
        .select({ n: count() })
        .from(project_report_metric)
        .innerJoin(project_report, eq(project_report.id, project_report_metric.project_report_id))
        .where(
          and(
            eq(project_report.project_id, projectId),
            gte(project_report_metric.date_created, since.toISOString()),
          ),
        );
      return Number(row?.n ?? 0);
    },

    async addMetric(reportId: number, type: string, now: Date) {
      await db.insert(project_report_metric).values({
        project_report_id: reportId,
        type,
        date_created: now.toISOString(),
      });
    },

    /** The project and conversation a subscription names, both alive and bound to each other. */
    async conversationInProject(projectId: string, conversationId: string): Promise<boolean> {
      if (!isUuid(projectId) || !isUuid(conversationId)) return false;
      const [row] = await db
        .select({ id: conversation.id })
        .from(conversation)
        .innerJoin(project, eq(project.id, conversation.project_id))
        .where(
          and(
            eq(conversation.id, conversationId),
            eq(conversation.project_id, projectId),
            isNull(conversation.deleted_at),
            isNull(project.deleted_at),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async subscriber(email: string, projectId: string) {
      const [row] = await db
        .select()
        .from(subscribers)
        .where(and(eq(subscribers.email, email), eq(subscribers.project_id, projectId)))
        .orderBy(subscribers.id)
        .limit(1);
      return row ?? null;
    },

    async deleteSubscriber(id: string) {
      await db.delete(subscribers).where(eq(subscribers.id, id));
    },

    async addSubscriber(row: {
      id: string;
      email: string;
      project_id: string;
      conversation_id: string;
      email_opt_out_token: string;
      now: Date;
    }) {
      await db.insert(subscribers).values({
        id: row.id,
        email: row.email,
        project_id: row.project_id,
        email_opt_in: true,
        conversation_id: row.conversation_id,
        email_opt_out_token: row.email_opt_out_token,
        date_submitted: row.now.toISOString(),
      });
    },

    async subscribersByToken(projectId: string, token: string) {
      if (!isUuid(token)) return [];
      return db
        .select({ id: subscribers.id, email_opt_in: subscribers.email_opt_in })
        .from(subscribers)
        .where(
          and(eq(subscribers.project_id, projectId), eq(subscribers.email_opt_out_token, token)),
        )
        .orderBy(subscribers.id);
    },

    async setOptIn(id: string, optIn: boolean, now: Date) {
      await db
        .update(subscribers)
        .set({ email_opt_in: optIn, date_updated: now.toISOString() })
        .where(eq(subscribers.id, id));
    },
  };
}
