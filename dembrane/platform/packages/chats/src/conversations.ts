import type { Db } from "@dembrane/db";
import { directusRow } from "@dembrane/legacy-shape";
import type postgres from "postgres";
import { isUuid, type Row } from "./storage";

/**
 * The conversation, project and billing reads the chat routes need: context sizing,
 * transcripts for the reply prompt, summaries for overview mode. Kept here, not in the
 * conversations namespace, because these are the chat's own views of those rows.
 */
export function chatReads(db: Db) {
  const sql = (db as unknown as { $client: postgres.Sql }).$client;

  const self = {
    /** A live conversation (conversation_service.get_by_id_or_raise without deleted rows). */
    async liveConversation(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [row] = await sql`select * from conversation where id = ${id} and deleted_at is null`;
      return row ? directusRow(row as Row) : null;
    },

    async conversation(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [row] = await sql`select * from conversation where id = ${id}`;
      return row ? directusRow(row as Row) : null;
    },

    /**
     * list_by_project_with_filters: live conversations of a project, minimal fields,
     * filtered by tags, verified artifacts, Directus search text and explicit ids.
     */
    async listWithFilters(q: {
      projectId: string;
      tagIds?: readonly string[] | null;
      verifiedOnly?: boolean;
      search?: string | null;
      limit: number;
      ids?: readonly string[] | null;
    }): Promise<Row[]> {
      if (q.ids && q.ids.length === 0) return [];
      const ids = q.ids?.filter(isUuid);
      if (q.ids && !ids?.length) return [];
      const search = q.search?.trim() ? q.search : null;
      const rows = await sql`
        select c.id, c.participant_name, c.is_over_cap from conversation c
        where c.project_id = ${q.projectId} and c.deleted_at is null
          ${ids ? sql`and c.id = any(${ids})` : sql``}
          ${
            q.tagIds?.length
              ? sql`and exists (select 1 from conversation_project_tag t
                    where t.conversation_id = c.id and t.project_tag_id = any(${q.tagIds.filter(isUuid)}))`
              : sql``
          }
          ${
            q.verifiedOnly
              ? sql`and exists (select 1 from conversation_artifact a
                    where a.conversation_id = c.id and a.approved_at is not null)`
              : sql``
          }
          ${search ? directusSearch(sql, search) : sql``}
        order by c.created_at desc
        limit ${q.limit}`;
      return rows.map((r) => ({ ...r }));
    },

    /** Ids among `ids` that have at least one chunk with a non-empty transcript. */
    async withContent(ids: readonly string[]): Promise<Set<string>> {
      if (!ids.length) return new Set();
      const rows = await sql`
        select distinct conversation_id from conversation_chunk
        where conversation_id = any(${ids.filter(isUuid)})
          and transcript is not null and transcript <> ''`;
      return new Set(rows.map((r) => r.conversation_id as string));
    },

    /**
     * conversation_service.list_by_ids: live conversations with their tags, in primary-key
     * order (Directus's default sort), the shape lock-conversations answers with.
     */
    async listByIds(ids: readonly string[]): Promise<Row[]> {
      const valid = ids.filter(isUuid);
      if (!valid.length) return [];
      const rows = await sql`
        select id, project_id, participant_name, participant_email, participant_user_agent,
               created_at, updated_at, duration, summary, source, is_finished, is_all_chunks_transcribed
        from conversation where id = any(${valid}) and deleted_at is null order by id limit 1000`;
      const tags = await sql`
        select j.id, j.conversation_id, t.id as tid, t.text
        from conversation_project_tag j left join project_tag t on t.id = j.project_tag_id
        where j.conversation_id = any(${valid}) order by j.id`;
      return rows.map((r) => ({
        ...directusRow(r as Row),
        tags: tags
          .filter((t) => t.conversation_id === r.id)
          .map((t) => ({ id: t.id, project_tag_id: t.tid ? { id: t.tid, text: t.text } : null })),
      }));
    },

    /** Persisted token counts of live conversations in one project. */
    async storedTokenCounts(
      ids: readonly string[],
      projectId: string,
    ): Promise<Map<string, number>> {
      const valid = ids.filter(isUuid);
      if (!valid.length || !projectId) return new Map();
      const rows = await sql`
        select id, token_count from conversation
        where id = any(${valid}) and project_id = ${projectId} and deleted_at is null`;
      const out = new Map<string, number>();
      for (const r of rows) if (typeof r.token_count === "number") out.set(r.id, r.token_count);
      return out;
    },

    /** Chunks with text, in timestamp order, capped as the transcript route capped them. */
    async transcriptChunks(conversationId: string): Promise<{ transcript: string | null }[]> {
      const rows = await sql`
        select transcript from conversation_chunk where conversation_id = ${conversationId}
        order by timestamp limit 1500`;
      return rows.map((r) => ({ transcript: r.transcript as string | null }));
    },

    /** Saves a computed token count only while the transcript is complete (no race with new chunks). */
    async persistTokenCount(conversationId: string, count: number, now: Date) {
      await sql`
        update conversation set token_count = ${count}, updated_at = ${now.toISOString()}
        where id = ${conversationId} and is_all_chunks_transcribed is true`;
    },

    /** Every live conversation of a project for overview mode, most recently updated first. */
    async overviewConversations(projectId: string): Promise<Row[]> {
      const rows = await sql`
        select c.id, c.participant_name, c.participant_email, c.summary, c.created_at, c.updated_at,
               c.duration,
               (select count(*)::int from conversation_chunk k where k.conversation_id = c.id) as chunks_count
        from conversation c
        where c.project_id = ${projectId} and c.deleted_at is null
        order by c.updated_at desc limit 1000`;
      return rows.map((r) => directusRow(r as Row));
    },

    /** All live conversations of a project with summaries (conversation_service.list_by_project). */
    async projectConversations(projectId: string): Promise<Row[]> {
      const rows = await sql`
        select id, participant_name, summary from conversation
        where project_id = ${projectId} and deleted_at is null order by id limit 1000`;
      return rows.map((r) => ({ ...r }));
    },

    /** Approved artifacts of conversations, for the deep-dive prompt. */
    async approvedArtifacts(ids: readonly string[]): Promise<Row[]> {
      if (!ids.length) return [];
      const rows = await sql`
        select conversation_id, key, content from conversation_artifact
        where conversation_id = any(${ids.filter(isUuid)}) and approved_at is not null order by id limit 100`;
      return rows.map((r) => ({ ...r }));
    },

    /** The newest three approved artifacts of one conversation, for its summary prompt. */
    async verifiedArtifacts(conversationId: string): Promise<Row[]> {
      const rows = await sql`
        select id, key, content from conversation_artifact
        where conversation_id = ${conversationId} and approved_at is not null
        order by approved_at desc limit 3`;
      return rows.map((r) => ({ ...r }));
    },

    async summaries(ids: readonly string[]): Promise<Map<string, string | null>> {
      if (!ids.length) return new Map();
      const rows =
        await sql`select id, summary from conversation where id = any(${ids.filter(isUuid)})`;
      return new Map(rows.map((r) => [r.id as string, r.summary as string | null]));
    },

    async updateConversation(id: string, values: Record<string, unknown>, now: Date) {
      await sql`
        update conversation set ${sql(values as Record<string, postgres.ParameterOrJSON<never>>)},
          updated_at = ${now.toISOString()}
        where id = ${id}`;
    },

    async recentTitles(projectId: string, limit: number): Promise<string[]> {
      const rows = await sql`
        select title from conversation
        where project_id = ${projectId} and title is not null and deleted_at is null
        order by created_at desc limit ${limit}`;
      return rows.map((r) => String(r.title));
    },

    async projectTags(projectId: string): Promise<{ id: string; text: string }[]> {
      const rows = await sql`
        select id, text from project_tag where project_id = ${projectId} order by sort`;
      return rows
        .filter((r) => typeof r.text === "string" && r.text.trim())
        .map((r) => ({ id: r.id as string, text: (r.text as string).trim() }));
    },

    async conversationTagIds(conversationId: string): Promise<Set<string>> {
      const rows = await sql`
        select project_tag_id from conversation_project_tag where conversation_id = ${conversationId}`;
      return new Set(rows.map((r) => r.project_tag_id as string).filter(Boolean));
    },

    async addConversationTag(conversationId: string, tagId: string) {
      await sql`
        insert into conversation_project_tag (conversation_id, project_tag_id)
        values (${conversationId}, ${tagId})`;
    },

    /** The project row fields the prompts read, or null. */
    async project(projectId: string): Promise<Row | null> {
      if (!isUuid(projectId)) return null;
      const [row] = await sql`select * from project where id = ${projectId}`;
      return row ? directusRow(row as Row) : null;
    },

    /** The project's tier through workspace and billing account; null when a link is missing. */
    async projectTier(projectId: string): Promise<string | null> {
      if (!isUuid(projectId)) return null;
      const [row] = await sql`
        select b.tier from project p
        join workspace w on w.id = p.workspace_id
        join billing_account b on b.id = w.billing_account_id
        where p.id = ${projectId}`;
      return (row?.tier as string | null) ?? null;
    },

    /** The project's workspace id, or null for a legacy project. */
    async projectWorkspace(projectId: string): Promise<string | null> {
      if (!isUuid(projectId)) return null;
      const [row] = await sql`select workspace_id from project where id = ${projectId}`;
      return (row?.workspace_id as string | null) ?? null;
    },

    /**
     * Chats that used the free tier's allowance: live chats in the workspace's projects
     * (deleted projects included, as the old count did) with at least one user message.
     * Chats on a sample copy, the seeded one included, spend none of it.
     */
    async workspaceChatsWithUserMessages(workspaceId: string | null): Promise<number> {
      if (!workspaceId) return 0;
      const [row] = await sql`
        select count(distinct m.project_chat_id)::int as n
        from project_chat_message m
        join project_chat c on c.id = m.project_chat_id
        join project p on p.id = c.project_id
        where p.workspace_id = ${workspaceId} and not p.is_sample and c.deleted_at is null
          and m.message_from = 'user'`;
      return Number(row?.n ?? 0);
    },

    /** The app user's email, for the analytics distinct id. */
    async appUserEmail(directusUserId: string): Promise<string | null> {
      const [row] = await sql`
        select email from app_user where directus_user_id = ${directusUserId} limit 1`;
      return (row?.email as string | null) ?? null;
    },
  };
  return self;
}

export type ChatReads = ReturnType<typeof chatReads>;

/**
 * Directus's `search` query parameter on conversation: a case-insensitive substring match
 * over its text columns, and an exact id match when the term is a uuid.
 */
function directusSearch(sql: postgres.Sql, term: string) {
  const like = `%${term.toLowerCase()}%`;
  return sql`and (
    lower(c.participant_email) like ${like} or lower(c.participant_name) like ${like}
    or lower(c.participant_user_agent) like ${like} or lower(c.source) like ${like}
    or lower(c.summary) like ${like} or lower(c.title) like ${like}
    or lower(c.merged_transcript) like ${like} or lower(c.merged_audio_path) like ${like}
    ${isUuid(term) ? sql`or c.id = ${term} or c.project_id = ${term}` : sql``}
  )`;
}
