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

/** Who is searching: decides which projects the transcript scan may touch. */
export interface Searcher {
  appUserId: string;
  directusUserId: string;
}

/**
 * The conversations of projects the searcher might read: a live membership in the
 * workspace, an org membership that reaches the workspace, or a legacy project they
 * created. A superset of what the access rules allow (the exact check stays in the
 * route), built from the small membership tables. The transcript scan keeps only chunks
 * of these conversations, so a rare phrase is no longer matched against every chunk of
 * every project.
 */
async function reachableConversations(db: Db, who: Searcher): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from conversation c
    join project p on p.id = c.project_id
    where p.deleted_at is null and (
      p.workspace_id in (
        select wm.workspace_id from workspace_membership wm
        where wm.user_id = ${who.appUserId} and wm.deleted_at is null)
      or p.workspace_id in (
        select w.id from workspace w
        join org_membership om on om.org_id = w.org_id
        where om.user_id = ${who.appUserId} and om.deleted_at is null and w.deleted_at is null)
      or (p.workspace_id is null and p.directus_user_id = ${who.directusUserId}))`);
  return [...rows].map((r) => r.id);
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
          // Live conversations only, as the project list counts them.
          conversations_count: sql<number>`(select count(*)::int from conversation c where c.project_id = "project"."id" and c.deleted_at is null)`,
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

    /**
     * Phrase match on transcripts: a spoken phrase is contiguous. Only chunks of projects
     * the searcher might read are matched, and the newest ones are cut to the limit before
     * the conversation and project are joined, so the joins run for a handful of rows. The
     * ids go in as one array value, which Postgres hashes and sizes when planning. Inlined,
     * `= any(array(subquery))` was checked row by row (minutes for 90k conversations) and
     * `in (subquery)` walked every chunk by timestamp for a rare phrase (4.5 s).
     */
    async chunks(term: string, limit: number, who: Searcher) {
      const reachable = await reachableConversations(db, who);
      if (!reachable.length) return [];
      // One bound parameter however many ids, unlike inArray's one per id.
      const reachableIds = `{${reachable.join(",")}}`;
      const hit = db
        .select({
          id: conversation_chunk.id,
          transcript: conversation_chunk.transcript,
          timestamp: conversation_chunk.timestamp,
          created_at: conversation_chunk.created_at,
          conversation_id: conversation_chunk.conversation_id,
        })
        .from(conversation_chunk)
        .where(
          and(
            sql`${conversation_chunk.conversation_id} = any (${reachableIds}::uuid[])`,
            or(
              icontains(conversation_chunk.transcript, term),
              icontains(conversation_chunk.raw_transcript, term),
            ),
          ),
        )
        .orderBy(desc(conversation_chunk.timestamp), conversation_chunk.id)
        .limit(limit)
        .as("hit");
      return db
        .select({
          id: hit.id,
          transcript: hit.transcript,
          timestamp: hit.timestamp,
          created_at: hit.created_at,
          conversation_id: conversation.id,
          participant_name: conversation.participant_name,
          project_id: conversation.project_id,
          workspace_id: project.workspace_id,
        })
        .from(hit)
        .leftJoin(conversation, eq(conversation.id, hit.conversation_id))
        .leftJoin(project, eq(project.id, conversation.project_id))
        .orderBy(desc(hit.timestamp), hit.id);
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
