import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, count, desc, eq, gt, gte, inArray, lte, type SQL } from "drizzle-orm";

const {
  support_request,
  model_response_feedback: mrf,
  project_chat_message,
  project_chat,
  project,
  workspace,
  org,
  directus_users,
} = schema;

export type FeedbackRowDb = typeof mrf.$inferSelect;

export interface AdminFilter {
  rating?: string;
  target_type?: string;
  reason?: string;
  chat_mode?: string;
  date_from?: string;
  date_to?: string;
}

export function feedbackStorage(db: Db) {
  return {
    async directusProfile(directusUserId: string) {
      const [row] = await db
        .select({
          email: directus_users.email,
          first: directus_users.first_name,
          last: directus_users.last_name,
        })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId));
      return row ?? null;
    },

    async insertSupportRequest(row: typeof support_request.$inferInsert) {
      await db.insert(support_request).values(row);
    },

    async chatMessage(id: string) {
      const [row] = await db
        .select()
        .from(project_chat_message)
        .where(eq(project_chat_message.id, id));
      return row ?? null;
    },

    async chat(id: string) {
      const [row] = await db.select().from(project_chat).where(eq(project_chat.id, id));
      return row ?? null;
    },

    /** Nearest user turn at or before the answer, else the nearest after it. */
    async precedingUserMessage(chatId: string, answeredAt: string | null) {
      const base = [
        eq(project_chat_message.project_chat_id, chatId),
        inArray(project_chat_message.message_from, ["user", "User"]),
      ];
      const attempts: [SQL | undefined, "asc" | "desc"][] = answeredAt
        ? [
            [lte(project_chat_message.date_created, answeredAt), "desc"],
            [gt(project_chat_message.date_created, answeredAt), "asc"],
          ]
        : [[undefined, "desc"]];
      for (const [cond, dir] of attempts) {
        const [row] = await db
          .select({ text: project_chat_message.text })
          .from(project_chat_message)
          .where(and(...base, ...(cond ? [cond] : [])))
          .orderBy(
            dir === "desc"
              ? desc(project_chat_message.date_created)
              : asc(project_chat_message.date_created),
          )
          .limit(1);
        if (row?.text) return row.text;
      }
      return null;
    },

    async ownRow(userId: string, targetType: string, targetId: string) {
      const [row] = await db
        .select()
        .from(mrf)
        .where(
          and(
            eq(mrf.user_id, userId),
            eq(mrf.target_type, targetType),
            eq(mrf.target_id, targetId),
          ),
        )
        .orderBy(asc(mrf.date_created), asc(mrf.id))
        .limit(1);
      return row ?? null;
    },

    async insertFeedback(row: typeof mrf.$inferInsert) {
      const [created] = await db.insert(mrf).values(row).returning();
      return created as FeedbackRowDb;
    },

    async updateFeedback(id: string, patch: Partial<typeof mrf.$inferInsert>) {
      const [updated] = await db.update(mrf).set(patch).where(eq(mrf.id, id)).returning();
      return updated as FeedbackRowDb;
    },

    async deleteFeedback(id: string) {
      await db.delete(mrf).where(eq(mrf.id, id));
    },

    async ownRows(userId: string, targetType: string, ids: readonly string[], limit: number) {
      return db
        .select()
        .from(mrf)
        .where(
          and(
            eq(mrf.user_id, userId),
            eq(mrf.target_type, targetType),
            inArray(mrf.target_id, [...ids]),
          ),
        )
        .orderBy(asc(mrf.id))
        .limit(limit);
    },

    async adminPage(f: AdminFilter, page: number, limit: number) {
      const conds: SQL[] = [];
      if (f.rating) conds.push(eq(mrf.rating, f.rating));
      if (f.target_type) conds.push(eq(mrf.target_type, f.target_type));
      if (f.reason) conds.push(eq(mrf.reason, f.reason));
      if (f.chat_mode) conds.push(eq(mrf.chat_mode, f.chat_mode));
      if (f.date_from) conds.push(gte(mrf.date_created, f.date_from));
      if (f.date_to) conds.push(lte(mrf.date_created, f.date_to));
      const where = conds.length ? and(...conds) : undefined;
      const rows = await db
        .select({
          row: mrf,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          projectWorkspaceId: project.workspace_id,
          orgName: org.name,
          userEmail: directus_users.email,
          userFirst: directus_users.first_name,
          userLast: directus_users.last_name,
          projectExists: project.id,
        })
        .from(mrf)
        .leftJoin(project, eq(project.id, mrf.project_id))
        .leftJoin(workspace, eq(workspace.id, project.workspace_id))
        .leftJoin(org, eq(org.id, workspace.org_id))
        .leftJoin(directus_users, eq(directus_users.id, mrf.user_id))
        .where(where)
        .orderBy(desc(mrf.date_created), asc(mrf.id))
        .limit(limit)
        .offset((page - 1) * limit);
      const [total] = await db.select({ n: count() }).from(mrf).where(where);
      return { rows, total: total?.n ?? 0 };
    },
  };
}

export type FeedbackStore = ReturnType<typeof feedbackStorage>;
