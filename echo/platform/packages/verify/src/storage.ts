import { isUuid } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

const {
  project,
  conversation,
  conversation_chunk,
  conversation_artifact,
  verification_topic,
  verification_topic_translations: translations,
} = schema;

export type ArtifactRow = typeof conversation_artifact.$inferSelect;
export type TopicRow = typeof verification_topic.$inferSelect;
export type TranslationRow = typeof translations.$inferSelect;

/** The verify routes' queries. The Python API read projects and conversations without a deleted filter; callers decide. */
export function verifyStorage(db: Db) {
  return {
    async project(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(project).where(eq(project.id, id)).limit(1);
      return row ?? null;
    },

    /** Global topics plus the project's own, each with its translations in key order. */
    async topics(projectId: string) {
      const rows = await db
        .select()
        .from(verification_topic)
        .where(
          or(isNull(verification_topic.project_id), eq(verification_topic.project_id, projectId)),
        )
        .orderBy(asc(verification_topic.sort), asc(verification_topic.date_created));
      const tr = rows.length
        ? await db
            .select()
            .from(translations)
            .where(
              inArray(
                translations.verification_topic_key,
                rows.map((r) => r.key),
              ),
            )
            .orderBy(asc(translations.id))
        : [];
      return rows.map((t) => ({
        topic: t,
        translations: tr.filter((x) => x.verification_topic_key === t.key),
      }));
    },

    async customTopic(projectId: string, key: string) {
      const [row] = await db
        .select()
        .from(verification_topic)
        .where(and(eq(verification_topic.key, key), eq(verification_topic.project_id, projectId)))
        .limit(1);
      if (!row) return null;
      const tr = await db
        .select()
        .from(translations)
        .where(eq(translations.verification_topic_key, key))
        .orderBy(asc(translations.id));
      return { topic: row, translations: tr };
    },

    async setSelected(projectId: string, list: string | null, now: Date) {
      await db
        .update(project)
        .set({ selected_verification_key_list: list, updated_at: now.toISOString() })
        .where(eq(project.id, projectId));
    },

    async createTopic(
      t: {
        key: string;
        prompt: string;
        icon: string | null;
        projectId: string;
        userId: string | null;
      },
      labels: { languages_code: string; label: string }[],
      now: Date,
    ) {
      await db.insert(verification_topic).values({
        key: t.key,
        prompt: t.prompt,
        icon: t.icon,
        project_id: t.projectId,
        user_created: t.userId,
        date_created: now.toISOString(),
      });
      for (const l of labels)
        await db.insert(translations).values({ ...l, verification_topic_key: t.key });
    },

    async updateTopic(
      key: string,
      fields: { prompt?: string; icon?: string | null },
      labelUpdates: { id: number; label: string }[],
      labelCreates: { languages_code: string; label: string }[],
      userId: string | null,
      now: Date,
    ) {
      await db
        .update(verification_topic)
        .set({ ...fields, date_updated: now.toISOString(), user_updated: userId })
        .where(eq(verification_topic.key, key));
      for (const u of labelUpdates)
        await db.update(translations).set({ label: u.label }).where(eq(translations.id, u.id));
      for (const l of labelCreates)
        await db.insert(translations).values({ ...l, verification_topic_key: key });
    },

    /** The translation rows stay with a null key, as the foreign key's ON DELETE SET NULL left them. */
    async deleteTopic(key: string) {
      await db.delete(verification_topic).where(eq(verification_topic.key, key));
    },

    async conversation(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select({ conversation, project })
        .from(conversation)
        .leftJoin(project, eq(project.id, conversation.project_id))
        .where(eq(conversation.id, id))
        .limit(1);
      return row ?? null;
    },

    async artifacts(conversationId: string) {
      return db
        .select()
        .from(conversation_artifact)
        .where(eq(conversation_artifact.conversation_id, conversationId))
        .orderBy(asc(conversation_artifact.date_created), asc(conversation_artifact.id));
    },

    async artifact(id: string) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(conversation_artifact)
        .where(eq(conversation_artifact.id, id))
        .limit(1);
      return row ?? null;
    },

    async chunks(conversationId: string) {
      return db
        .select({
          id: conversation_chunk.id,
          timestamp: conversation_chunk.timestamp,
          transcript: conversation_chunk.transcript,
          path: conversation_chunk.path,
        })
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
        .limit(1500);
    },

    async createArtifact(a: {
      id: string;
      conversationId: string;
      key: string;
      topicLabel: string | null;
      content: string;
      now: Date;
    }): Promise<ArtifactRow> {
      const [row] = await db
        .insert(conversation_artifact)
        .values({
          id: a.id,
          conversation_id: a.conversationId,
          key: a.key,
          topic_label: a.topicLabel,
          content: a.content,
          read_aloud_stream_url: "",
          date_created: a.now.toISOString(),
        })
        .returning();
      return row as ArtifactRow;
    },

    async updateArtifact(id: string, fields: { content?: string; approved_at?: string }) {
      const [row] = await db
        .update(conversation_artifact)
        .set(fields)
        .where(eq(conversation_artifact.id, id))
        .returning();
      return row ?? null;
    },
  };
}

export type VerifyStorage = ReturnType<typeof verifyStorage>;
