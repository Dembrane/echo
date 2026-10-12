import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { directusRow } from "@dembrane/legacy-shape";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type postgres from "postgres";

const { project, project_chat, project_chat_message, project_chat_conversation, conversation } =
  schema;

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Directus answered a malformed id on a uuid column with "not found"; so do we, without a query. */
export const isUuid = (v: string) => UUID.test(v);

/** A conversation attached to a chat, as Directus expanded `used_conversations.conversation_id.*`. */
export interface AttachedConversation {
  /** The junction row id. */
  readonly id: number;
  readonly conversation_id: {
    readonly id: string;
    readonly participant_name: string | null;
    readonly deleted_at: string | null;
  } | null;
}

/** A chat row the way chat_service.get_by_id_or_raise returned it. */
export interface ChatRow {
  readonly id: string;
  readonly name: string | null;
  readonly chat_mode: string | null;
  readonly deleted_at: string | null;
  readonly is_private: boolean;
  readonly user_created: string | null;
  readonly project_id: { readonly id: string; readonly directus_user_id: string | null } | null;
  readonly used_conversations?: readonly AttachedConversation[];
}

/**
 * Chat and chat-message queries shared by the v1 chat routes, the chat BFF and the agentic
 * namespace. The service layer decides access; nothing here filters by caller.
 */
export function chatsStorage(db: Db) {
  const self = {
    /** The raw pool, for callers that enqueue or publish in the same transaction. */
    sql(): postgres.Sql {
      return (db as unknown as { $client: postgres.Sql }).$client;
    },

    /** The chat row with its project; `withUsed` adds attached conversations in junction id order. */
    async chat(id: string, withUsed = false): Promise<ChatRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select({
          id: project_chat.id,
          name: project_chat.name,
          chat_mode: project_chat.chat_mode,
          deleted_at: project_chat.deleted_at,
          is_private: project_chat.is_private,
          user_created: project_chat.user_created,
          project_id: project_chat.project_id,
          owner: project.directus_user_id,
        })
        .from(project_chat)
        .leftJoin(project, eq(project.id, project_chat.project_id))
        .where(eq(project_chat.id, id))
        .limit(1);
      if (!row) return null;
      const chat: ChatRow = {
        id: row.id,
        name: row.name,
        chat_mode: row.chat_mode,
        deleted_at: directusRow({ v: row.deleted_at }).v as string | null,
        is_private: Boolean(row.is_private),
        user_created: row.user_created,
        project_id: row.project_id ? { id: row.project_id, directus_user_id: row.owner } : null,
      };
      if (!withUsed) return chat;
      return { ...chat, used_conversations: await self.attached(id) };
    },

    /** Junction rows of a chat, sorted by junction id (the Directus deep sort). */
    async attached(chatId: string): Promise<AttachedConversation[]> {
      const rows = await db
        .select({
          id: project_chat_conversation.id,
          cid: conversation.id,
          participant_name: conversation.participant_name,
          deleted_at: conversation.deleted_at,
        })
        .from(project_chat_conversation)
        .leftJoin(conversation, eq(conversation.id, project_chat_conversation.conversation_id))
        .where(eq(project_chat_conversation.project_chat_id, chatId))
        .orderBy(asc(project_chat_conversation.id));
      return rows.map((r) => ({
        id: r.id,
        conversation_id: r.cid
          ? {
              id: r.cid,
              participant_name: r.participant_name,
              deleted_at: directusRow({ v: r.deleted_at }).v as string | null,
            }
          : null,
      }));
    },

    /**
     * Inserts a chat message. Directus stamped date_created on create (date_updated only
     * on later updates) and wrote nested used/added conversation links in the same request.
     */
    async createMessage(values: {
      id: string;
      chatId: string;
      from: string;
      text: string;
      now: Date;
      templateKey?: string | null;
      usedConversationIds?: readonly string[];
      addedConversationIds?: readonly string[];
    }): Promise<Row> {
      const at = values.now.toISOString();
      return self.sql().begin(async (tx) => {
        const [row] = await tx`
          insert into project_chat_message
            (id, project_chat_id, message_from, text, template_key, date_created)
          values (${values.id}, ${values.chatId}, ${values.from}, ${values.text},
                  ${values.templateKey ?? null}, ${at})
          on conflict (id) do nothing
          returning *`;
        for (const cid of values.usedConversationIds ?? [])
          await tx`insert into project_chat_message_conversation (project_chat_message_id, conversation_id)
                   values (${values.id}, ${cid})`;
        for (const cid of values.addedConversationIds ?? [])
          await tx`insert into project_chat_message_conversation_1 (project_chat_message_id, conversation_id)
                   values (${values.id}, ${cid})`;
        return row ? directusRow(row as Row) : { id: values.id };
      }) as Promise<Row>;
    },

    /** `by` is who made the change; system writes (a generated title) leave user_updated alone. */
    async setChatName(chatId: string, name: string | null, now: Date, by?: string) {
      await db
        .update(project_chat)
        .set({ name, date_updated: now.toISOString(), ...(by && { user_updated: by }) })
        .where(eq(project_chat.id, chatId));
    },

    async setChatMode(chatId: string, mode: string, now: Date, by?: string) {
      await db
        .update(project_chat)
        .set({ chat_mode: mode, date_updated: now.toISOString(), ...(by && { user_updated: by }) })
        .where(eq(project_chat.id, chatId));
    },

    /** User turns in a chat, for the free tier's per-chat turn cap. */
    async countUserTurns(chatId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(project_chat_message)
        .where(
          and(
            eq(project_chat_message.project_chat_id, chatId),
            eq(project_chat_message.message_from, "user"),
          ),
        );
      return Number(row?.n ?? 0);
    },

    /** User turns across a project's live chats, for a sample copy's free-tier allowance. */
    async countProjectUserTurns(projectId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(project_chat_message)
        .innerJoin(project_chat, eq(project_chat.id, project_chat_message.project_chat_id))
        .where(
          and(
            eq(project_chat.project_id, projectId),
            isNull(project_chat.deleted_at),
            eq(project_chat_message.message_from, "user"),
          ),
        );
      return Number(row?.n ?? 0);
    },

    // ── chat items as Directus served them ────────────────────────────

    /** Every column plus the o2m/m2m id lists, as a Directus create or update answered. */
    async chatItem(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const sql = self.sql();
      const [row] = await sql`select * from project_chat where id = ${id}`;
      if (!row) return null;
      const msgs =
        await sql`select id from project_chat_message where project_chat_id = ${id} order by id`;
      const used =
        await sql`select id from project_chat_conversation where project_chat_id = ${id} order by id`;
      return {
        ...directusRow(row as Row),
        project_chat_messages: msgs.map((r) => r.id),
        used_conversations: used.map((r) => r.id),
      };
    },

    async messageItem(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const sql = self.sql();
      const [row] = await sql`select * from project_chat_message where id = ${id}`;
      if (!row) return null;
      const used =
        await sql`select id from project_chat_message_conversation where project_chat_message_id = ${id} order by id`;
      const added =
        await sql`select id from project_chat_message_conversation_1 where project_chat_message_id = ${id} order by id`;
      return {
        ...directusRow(row as Row),
        used_conversations: used.map((r) => r.id),
        added_conversations: added.map((r) => r.id),
      };
    },

    async insertChat(values: {
      id: string;
      projectId: string;
      name?: string;
      userCreated: string;
      now: Date;
    }) {
      const at = values.now.toISOString();
      await self.sql()`
        insert into project_chat (id, project_id, name, user_created, date_created)
        values (${values.id}, ${values.projectId}, ${values.name ?? null}, ${values.userCreated}, ${at})`;
    },

    async updateChat(id: string, values: Record<string, unknown>, userUpdated: string, now: Date) {
      const sql = self.sql();
      await sql`
        update project_chat set ${sql(values as Record<string, postgres.ParameterOrJSON<never>>)},
          user_updated = ${userUpdated}, date_updated = ${now.toISOString()}
        where id = ${id}`;
    },

    async softDeleteChat(id: string, at: string, now: Date, by: string) {
      await self.sql()`
        update project_chat set deleted_at = ${at}, date_updated = ${now.toISOString()},
          user_updated = ${by} where id = ${id}`;
    },

    /** The BFF chat list: live chats of a project, newest first, with optional filters. */
    async listChats(q: {
      projectId: string;
      hasMessages: boolean;
      search: string;
      limit: number;
      offset: number;
      visibleTo: string | null;
    }): Promise<{ rows: Row[]; total: number }> {
      const sql = self.sql();
      const where = sql`
        c.project_id = ${q.projectId} and c.deleted_at is null
        ${q.hasMessages ? sql`and exists (select 1 from project_chat_message m where m.project_chat_id = c.id)` : sql``}
        ${q.search ? sql`and c.name ilike ${`%${q.search}%`}` : sql``}
        ${q.visibleTo ? sql`and (c.is_private is not true or c.user_created = ${q.visibleTo})` : sql``}`;
      const rows = await sql`
        select c.id, c.project_id, c.date_created, c.date_updated, c.name, c.chat_mode
        from project_chat c where ${where}
        order by c.date_created desc, c.id
        limit ${q.limit} offset ${q.offset}`;
      const [n] = await sql`select count(*)::int as n from project_chat c where ${where}`;
      return { rows: rows.map((r) => directusRow(r as Row)), total: Number(n?.n ?? 0) };
    },

    // ── messages ──────────────────────────────────────────────────────

    /**
     * Messages of a chat in date order (chat_service.list_messages). `withRelations` adds
     * the used and added conversations each message carries, junction-id sorted.
     */
    async messages(
      chatId: string,
      opts: { withRelations: boolean; order: "asc" | "desc"; limit?: number },
    ): Promise<Row[]> {
      const sql = self.sql();
      const rows = await sql`
        select id, project_chat_id, message_from, text, tokens_count, template_key, date_created
        from project_chat_message where project_chat_id = ${chatId}
        order by date_created ${opts.order === "desc" ? sql`desc` : sql`asc`} , id
        limit ${opts.limit ?? 1000}`;
      const out = rows.map((r) => directusRow(r as Row));
      if (!opts.withRelations || !out.length) return out;
      const ids = out.map((r) => r.id as string);
      const used = await sql`
        select j.id, j.project_chat_message_id as mid, c.id as cid, c.participant_name, c.summary, c.duration
        from project_chat_message_conversation j left join conversation c on c.id = j.conversation_id
        where j.project_chat_message_id = any(${ids}) order by j.id`;
      const added = await sql`
        select j.id, j.project_chat_message_id as mid, c.id as cid, c.participant_name
        from project_chat_message_conversation_1 j left join conversation c on c.id = j.conversation_id
        where j.project_chat_message_id = any(${ids}) order by j.id`;
      for (const m of out) {
        m.used_conversations = used
          .filter((u) => u.mid === m.id)
          .map((u) => ({
            id: u.id,
            conversation_id: u.cid
              ? {
                  id: u.cid,
                  participant_name: u.participant_name,
                  summary: u.summary,
                  duration: u.duration,
                }
              : null,
          }));
        m.added_conversations = added
          .filter((u) => u.mid === m.id)
          .map((u) => ({
            id: u.id,
            conversation_id: u.cid ? { id: u.cid, participant_name: u.participant_name } : null,
          }));
      }
      return out;
    },

    /** The BFF message list, with the added conversations expanded for the "Context added" line. */
    async bffMessages(chatId: string, limit: number): Promise<Row[]> {
      const sql = self.sql();
      const rows = await sql`
        select id, date_created, message_from, text, template_key, tokens_count, project_chat_id
        from project_chat_message where project_chat_id = ${chatId}
        order by date_created asc , id limit ${limit}`;
      const out = rows.map((r) => directusRow(r as Row));
      if (!out.length) return out;
      const ids = out.map((r) => r.id as string);
      const used = await sql`
        select id, project_chat_message_id as mid from project_chat_message_conversation
        where project_chat_message_id = any(${ids}) order by id`;
      const added = await sql`
        select j.id, j.project_chat_message_id as mid, c.id as cid, c.participant_name
        from project_chat_message_conversation_1 j left join conversation c on c.id = j.conversation_id
        where j.project_chat_message_id = any(${ids}) order by j.id`;
      return out.map((m) => ({
        id: m.id,
        date_created: m.date_created,
        message_from: m.message_from,
        text: m.text,
        template_key: m.template_key,
        tokens_count: m.tokens_count,
        used_conversations: used.filter((u) => u.mid === m.id).map((u) => u.id),
        added_conversations: added
          .filter((u) => u.mid === m.id)
          .map((u) => ({
            id: u.id,
            conversation_id: u.cid ? { id: u.cid, participant_name: u.participant_name } : null,
          })),
        project_chat_id: m.project_chat_id,
      }));
    },

    async message(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [row] = await self.sql()`select * from project_chat_message where id = ${id}`;
      return row ? directusRow(row as Row) : null;
    },

    async updateMessage(id: string, values: Record<string, unknown>, now: Date) {
      const sql = self.sql();
      await sql`
        update project_chat_message set ${sql(values as Record<string, postgres.ParameterOrJSON<never>>)},
          date_updated = ${now.toISOString()}
        where id = ${id}`;
    },

    /** Deletes a message; its junction rows are set null by the foreign keys, as Directus left them. */
    async deleteMessage(id: string) {
      await self.sql()`delete from project_chat_message where id = ${id}`;
    },

    async lastAssistantMessage(chatId: string): Promise<string | null> {
      const [row] = await self.sql()`
        select text from project_chat_message
        where project_chat_id = ${chatId} and message_from = 'assistant'
        order by date_created desc limit 1`;
      return (row?.text as string | null) ?? null;
    },

    /** Recent user questions: this chat first, then the project's other recent chats. */
    async recentUserQueries(projectId: string, chatId: string | null, limit: number) {
      const sql = self.sql();
      const out: string[] = [];
      if (chatId) {
        const rows = await sql`
          select text from project_chat_message
          where project_chat_id = ${chatId} and message_from = 'user'
          order by date_created desc limit ${limit}`;
        for (const r of rows) {
          const t = String(r.text ?? "").trim();
          if (t && !out.includes(t)) out.push(t);
        }
      }
      if (out.length < limit) {
        const chats = await sql`
          select id from project_chat where project_id = ${projectId} and deleted_at is null
          order by date_created desc limit 10`;
        const others = chats.map((c) => c.id as string).filter((id) => id !== chatId);
        if (others.length) {
          const rows = await sql`
            select text from project_chat_message
            where project_chat_id = any(${others}) and message_from = 'user'
            order by date_created desc limit ${limit - out.length}`;
          for (const r of rows) {
            const t = String(r.text ?? "").trim();
            if (t && !out.includes(t)) {
              out.push(t);
              if (out.length >= limit) break;
            }
          }
        }
      }
      return out.slice(0, limit);
    },

    // ── chat context links ────────────────────────────────────────────

    async attachConversations(chatId: string, conversationIds: readonly string[]) {
      if (!conversationIds.length) return;
      const sql = self.sql();
      await sql`
        insert into project_chat_conversation ${sql(
          conversationIds.map((conversation_id) => ({ conversation_id, project_chat_id: chatId })),
        )}`;
    },

    async detachConversation(chatId: string, conversationId: string) {
      await self.sql()`
        delete from project_chat_conversation
        where project_chat_id = ${chatId} and conversation_id = ${conversationId}`;
    },

    /** Conversations attached to a chat with their summaries (deep-dive suggestions), max 50. */
    async lockedConversationsWithSummaries(chatId: string) {
      const rows = await self.sql()`
        select c.id, c.participant_name, c.summary
        from project_chat_conversation j join conversation c on c.id = j.conversation_id
        where j.project_chat_id = ${chatId} order by j.id limit 50`;
      return rows.map((r) => ({
        id: r.id as string,
        name: (r.participant_name as string | null) ?? "Unknown",
        summary: r.summary as string | null,
      }));
    },
  };
  return self;
}

export type ChatsStorage = ReturnType<typeof chatsStorage>;
