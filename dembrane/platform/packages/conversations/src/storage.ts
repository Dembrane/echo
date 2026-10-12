import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

const { conversation, conversation_chunk, conversation_project_tag, project, project_tag } = schema;

export type ConversationRow = typeof conversation.$inferSelect;
export type ChunkRow = typeof conversation_chunk.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids arrive from paths and bodies; one that is not a uuid names nothing, like a missing row. */
export const isUuid = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/** A database handle plus the raw transaction, so jobs are enqueued in the same commit. */
export interface Tx {
  readonly db: Db;
  readonly sql: postgres.TransactionSql;
}

/** Runs fn in one transaction; the queue writes through `sql` so a job exists only if the write commits. */
export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = (db as unknown as { $client: postgres.Sql }).$client;
  return (await client.begin(async (txSql) => {
    // Drizzle reads the parser options off its client; a transaction handle has none of
    // its own, so it borrows the pool's (already set up for string timestamps).
    const bound = Object.assign(txSql, { options: client.options }) as unknown as postgres.Sql;
    return fn({ db: drizzle(bound, { schema }) as unknown as Db, sql: txSql });
  })) as T;
}

/** The conversation reads every surface shares. Soft-deleted rows are filtered here. */
export function conversationStore(db: Db) {
  return {
    /** A conversation that is not soft-deleted. */
    async conversation(id: string): Promise<ConversationRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(conversation)
        .where(and(eq(conversation.id, id), isNull(conversation.deleted_at)))
        .limit(1);
      return row ?? null;
    },

    async conversationIncludingDeleted(id: string): Promise<ConversationRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(conversation).where(eq(conversation.id, id)).limit(1);
      return row ?? null;
    },

    /** project_service.get_by_id_or_raise: a project that is not soft-deleted. */
    async project(id: string): Promise<ProjectRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(project)
        .where(and(eq(project.id, id), isNull(project.deleted_at)))
        .limit(1);
      if (!row) return null;
      // A sample copy never takes a conversation, whatever its portal toggle says: what
      // is recorded there would count toward no limit (packages/samples).
      return row.is_sample ? { ...row, is_conversation_allowed: false } : row;
    },

    async chunk(id: string): Promise<ChunkRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(conversation_chunk)
        .where(eq(conversation_chunk.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Chunks by timestamp, oldest first; Directus broke ties by primary key. */
    async chunks(conversationId: string, limit = 2000): Promise<ChunkRow[]> {
      if (!isUuid(conversationId)) return [];
      return db
        .select()
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id))
        .limit(limit);
    },

    /** Newest first, as the portal's chunk list and `with_chunks` asked Directus for. */
    async chunksNewestFirst(conversationId: string, limit = 1200): Promise<ChunkRow[]> {
      if (!isUuid(conversationId)) return [];
      return db
        .select()
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(desc(conversation_chunk.timestamp), asc(conversation_chunk.id))
        .limit(limit);
    },

    /** The project tags a conversation carries, as `tags.project_tag_id.*` expanded them. */
    async tagsOf(conversationId: string) {
      if (!isUuid(conversationId)) return [];
      return db
        .select({ link: conversation_project_tag, tag: project_tag })
        .from(conversation_project_tag)
        .leftJoin(project_tag, eq(project_tag.id, conversation_project_tag.project_tag_id))
        .where(eq(conversation_project_tag.conversation_id, conversationId))
        .orderBy(asc(conversation_project_tag.id));
    },

    async projectTags(projectId: string) {
      if (!isUuid(projectId)) return [];
      return db
        .select()
        .from(project_tag)
        .where(eq(project_tag.project_id, projectId))
        .orderBy(asc(project_tag.id));
    },

    async conversationsByIds(ids: readonly string[]): Promise<ConversationRow[]> {
      const valid = ids.filter(isUuid);
      if (!valid.length) return [];
      return db
        .select()
        .from(conversation)
        .where(and(inArray(conversation.id, valid), isNull(conversation.deleted_at)));
    },
  };
}

export type ConversationStore = ReturnType<typeof conversationStore>;
