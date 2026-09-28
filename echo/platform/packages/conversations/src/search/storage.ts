import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const { project, conversation, conversation_chunk, project_chat } = schema;

/** Directus _icontains: LOWER(col) LIKE '%term%', wildcards in the term left as they are. */
function icontains(col: AnyPgColumn, term: string): SQL {
  return sql`lower(${col}) like ${`%${term.toLowerCase()}%`}`;
}

/** Python's str.split(): whitespace-separated tokens, empties dropped. */
export function tokens(term: string): string[] {
  return term.split(/\s+/u).filter(Boolean);
}

/** Every token present, in any order, in at least one of the columns (search_filters.all_tokens_filter). */
function allTokens(cols: AnyPgColumn[], term: string): SQL | undefined {
  const toks = tokens(term);
  if (!toks.length) return undefined;
  return and(...toks.map((t) => or(...cols.map((c) => icontains(c, t)))));
}

/** The four home search sources, newest first, over-fetched so access filtering can trim them. */
export function searchStorage(db: Db) {
  return {
    projects(term: string, limit: number) {
      return db
        .select({
          id: project.id,
          name: project.name,
          workspace_id: project.workspace_id,
          updated_at: project.updated_at,
          // Directus's count(conversations) counted every related row, deleted ones too.
          conversations_count: sql<number>`(select count(*)::int from conversation c where c.project_id = "project"."id")`,
        })
        .from(project)
        .where(and(allTokens([project.name], term), isNull(project.deleted_at)))
        .orderBy(desc(project.updated_at), project.id)
        .limit(limit);
    },

    conversations(term: string, limit: number) {
      return db
        .select({
          id: conversation.id,
          created_at: conversation.created_at,
          is_finished: conversation.is_finished,
          is_all_chunks_transcribed: conversation.is_all_chunks_transcribed,
          participant_name: conversation.participant_name,
          participant_email: conversation.participant_email,
          summary: conversation.summary,
          project_id: conversation.project_id,
          project_name: project.name,
          workspace_id: project.workspace_id,
          last_chunk: sql<{ timestamp: string | null; created_at: string | null } | null>`(
            select json_build_object('timestamp', ch.timestamp, 'created_at', ch.created_at)
            from conversation_chunk ch where ch.conversation_id = "conversation"."id"
            order by ch.timestamp desc, ch.id limit 1)`,
        })
        .from(conversation)
        .leftJoin(project, eq(project.id, conversation.project_id))
        .where(
          and(
            isNull(conversation.deleted_at),
            allTokens(
              [conversation.participant_name, conversation.participant_email, conversation.summary],
              term,
            ),
          ),
        )
        .orderBy(desc(conversation.created_at), conversation.id)
        .limit(limit);
    },

    /** Phrase match on transcripts: a spoken phrase is contiguous. */
    chunks(term: string, limit: number) {
      return db
        .select({
          id: conversation_chunk.id,
          transcript: conversation_chunk.transcript,
          timestamp: conversation_chunk.timestamp,
          created_at: conversation_chunk.created_at,
          conversation_id: conversation.id,
          participant_name: conversation.participant_name,
          project_id: conversation.project_id,
          workspace_id: project.workspace_id,
        })
        .from(conversation_chunk)
        .leftJoin(conversation, eq(conversation.id, conversation_chunk.conversation_id))
        .leftJoin(project, eq(project.id, conversation.project_id))
        .where(
          or(
            icontains(conversation_chunk.transcript, term),
            icontains(conversation_chunk.raw_transcript, term),
          ),
        )
        .orderBy(desc(conversation_chunk.timestamp), conversation_chunk.id)
        .limit(limit);
    },

    chats(term: string, limit: number) {
      return db
        .select({
          id: project_chat.id,
          name: project_chat.name,
          project_id: project_chat.project_id,
          project_name: project.name,
          workspace_id: project.workspace_id,
        })
        .from(project_chat)
        .leftJoin(project, eq(project.id, project_chat.project_id))
        .where(and(isNull(project_chat.deleted_at), allTokens([project_chat.name], term)))
        .orderBy(desc(project_chat.date_updated), desc(project_chat.date_created), project_chat.id)
        .limit(limit);
    },
  };
}
