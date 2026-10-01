import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { isUuid } from "../storage";

const {
  conversation,
  conversation_chunk,
  conversation_artifact,
  conversation_project_tag,
  conversation_reply,
  project,
  project_tag,
  project_report_notification_participants,
} = schema;

/** The queries behind the v1 conversation routes, in the Directus queries' shapes and limits. */
export function v1Store(db: Db) {
  return {
    /**
     * get_chunk_counts read its chunks without a limit, so Directus applied its default of
     * 100 rows; a conversation with more chunks counts only the first hundred by key.
     */
    async chunkStates(conversationId: string) {
      if (!isUuid(conversationId)) return [];
      return db
        .select({
          id: conversation_chunk.id,
          error: conversation_chunk.error,
          transcript: conversation_chunk.transcript,
        })
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.id))
        .limit(100);
    },

    /** The transcript route's chunks: by timestamp, at most 1500. */
    async transcriptChunks(conversationId: string) {
      if (!isUuid(conversationId)) return [];
      return db
        .select({
          id: conversation_chunk.id,
          transcript: conversation_chunk.transcript,
          error: conversation_chunk.error,
        })
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
        .limit(1500);
    },

    /** Subscriber emails captured in this conversation, by key, at most 1000. */
    async emails(conversationId: string): Promise<string[]> {
      if (!isUuid(conversationId)) return [];
      const rows = await db
        .select({ email: project_report_notification_participants.email })
        .from(project_report_notification_participants)
        .where(eq(project_report_notification_participants.conversation_id, conversationId))
        .orderBy(asc(project_report_notification_participants.id))
        .limit(1000);
      return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
    },

    async conversation(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(conversation).where(eq(conversation.id, id)).limit(1);
      return row ?? null;
    },

    /** Any project row by id, soft-deleted or not (a Directus field expansion). */
    async projectAny(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(project).where(eq(project.id, id)).limit(1);
      return row ?? null;
    },

    async liveProject(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(project)
        .where(and(eq(project.id, id), isNull(project.deleted_at)))
        .limit(1);
      return row ?? null;
    },

    /** get_verified_artifacts: the three most recently approved, as {id, key, content}. */
    async verifiedArtifacts(conversationId: string, limit = 3) {
      return db
        .select({
          id: conversation_artifact.id,
          key: conversation_artifact.key,
          content: conversation_artifact.content,
        })
        .from(conversation_artifact)
        .where(
          and(
            eq(conversation_artifact.conversation_id, conversationId),
            isNotNull(conversation_artifact.approved_at),
          ),
        )
        .orderBy(desc(conversation_artifact.approved_at))
        .limit(limit);
    },

    /** Titles of the project's latest conversations, for style matching. */
    async recentTitles(projectId: string, limit = 10): Promise<string[]> {
      const rows = await db
        .select({ title: conversation.title })
        .from(conversation)
        .where(
          and(
            eq(conversation.project_id, projectId),
            isNotNull(conversation.title),
            isNull(conversation.deleted_at),
          ),
        )
        .orderBy(desc(conversation.created_at))
        .limit(limit);
      return rows.map((r) => r.title).filter((t): t is string => Boolean(t));
    },

    /** The project's tag vocabulary by sort (Directus puts null sorts first). */
    async projectTags(projectId: string) {
      return db
        .select({ id: project_tag.id, text: project_tag.text, sort: project_tag.sort })
        .from(project_tag)
        .where(eq(project_tag.project_id, projectId))
        .orderBy(sql`${project_tag.sort} asc nulls first`, asc(project_tag.id));
    },

    async currentTagIds(conversationId: string): Promise<Set<string>> {
      const rows = await db
        .select({ tag: conversation_project_tag.project_tag_id })
        .from(conversation_project_tag)
        .where(eq(conversation_project_tag.conversation_id, conversationId));
      return new Set(rows.map((r) => r.tag).filter((t): t is string => Boolean(t)));
    },

    async addTag(conversationId: string, tagId: string) {
      await db
        .insert(conversation_project_tag)
        .values({ conversation_id: conversationId, project_tag_id: tagId });
    },

    /** A Directus item update: the fields plus the date-updated stamp. */
    async updateConversation(
      id: string,
      data: Partial<typeof conversation.$inferInsert>,
      now: Date,
    ) {
      await db
        .update(conversation)
        .set({ ...data, updated_at: now.toISOString() })
        .where(eq(conversation.id, id));
    },

    /** Chunks and replies of the reply's conversation, oldest first. */
    async replyContext(conversationId: string) {
      const [chunks, replies, tags] = await Promise.all([
        db
          .select({
            id: conversation_chunk.id,
            timestamp: conversation_chunk.timestamp,
            transcript: conversation_chunk.transcript,
            path: conversation_chunk.path,
          })
          .from(conversation_chunk)
          .where(eq(conversation_chunk.conversation_id, conversationId))
          .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
          .limit(10000),
        db
          .select({
            date_created: conversation_reply.date_created,
            content_text: conversation_reply.content_text,
          })
          .from(conversation_reply)
          .where(eq(conversation_reply.reply, conversationId))
          .orderBy(asc(conversation_reply.date_created), asc(conversation_reply.id))
          .limit(1000),
        this.tagTexts([conversationId]),
      ]);
      return { chunks, replies, tags: tags.get(conversationId) ?? [] };
    },

    /** Tag texts per conversation, as `tags.project_tag_id.text` expanded them. */
    async tagTexts(conversationIds: readonly string[]): Promise<Map<string, (string | null)[]>> {
      const out = new Map<string, (string | null)[]>();
      if (!conversationIds.length) return out;
      const rows = await db
        .select({ cid: conversation_project_tag.conversation_id, text: project_tag.text })
        .from(conversation_project_tag)
        .innerJoin(project_tag, eq(project_tag.id, conversation_project_tag.project_tag_id))
        .where(inArray(conversation_project_tag.conversation_id, [...conversationIds]))
        .orderBy(asc(conversation_project_tag.id));
      for (const r of rows) {
        if (!r.cid) continue;
        out.set(r.cid, [...(out.get(r.cid) ?? []), r.text]);
      }
      return out;
    },

    /**
     * The other conversations of the project, as the reply prompt reads them. The query
     * had no limit or sort, so Directus returned its default 100 by key.
     */
    async adjacent(projectId: string, excludeId: string) {
      return db
        .select({
          id: conversation.id,
          participant_name: conversation.participant_name,
          summary: conversation.summary,
        })
        .from(conversation)
        .where(
          and(
            eq(conversation.project_id, projectId),
            ne(conversation.id, excludeId),
            isNull(conversation.deleted_at),
          ),
        )
        .orderBy(asc(conversation.id))
        .limit(100);
    },

    /** Latest chunks and replies of adjacent conversations, newest first (deep sort). */
    async adjacentContent(conversationId: string) {
      const [chunks, replies] = await Promise.all([
        db
          .select({
            timestamp: conversation_chunk.timestamp,
            transcript: conversation_chunk.transcript,
          })
          .from(conversation_chunk)
          .where(eq(conversation_chunk.conversation_id, conversationId))
          .orderBy(desc(conversation_chunk.timestamp))
          .limit(1000),
        db
          .select({
            date_created: conversation_reply.date_created,
            content_text: conversation_reply.content_text,
          })
          .from(conversation_reply)
          .where(eq(conversation_reply.reply, conversationId))
          .orderBy(desc(conversation_reply.date_created))
          .limit(1000),
      ]);
      return { chunks, replies };
    },

    async storeReply(conversationId: string, content: string, now: Date) {
      await db.insert(conversation_reply).values({
        id: newId(),
        conversation_id: conversationId,
        content_text: content,
        type: "assistant_reply",
        date_created: now.toISOString(),
      });
    },
  };
}

export type V1Store = ReturnType<typeof v1Store>;
