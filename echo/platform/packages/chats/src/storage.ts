import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { directusRow } from "@echo/legacy-shape";
import { and, asc, count, eq } from "drizzle-orm";
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
     * Inserts a chat message. Directus stamped date_created and date_updated on create
     * (both special fields), and nested used/added conversation links in the same request.
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
            (id, project_chat_id, message_from, text, template_key, date_created, date_updated)
          values (${values.id}, ${values.chatId}, ${values.from}, ${values.text},
                  ${values.templateKey ?? null}, ${at}, ${at})
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

    async setChatName(chatId: string, name: string | null, now: Date) {
      await db
        .update(project_chat)
        .set({ name, date_updated: now.toISOString() })
        .where(eq(project_chat.id, chatId));
    },

    async setChatMode(chatId: string, mode: string, now: Date) {
      await db
        .update(project_chat)
        .set({ chat_mode: mode, date_updated: now.toISOString() })
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
  };
  return self;
}

export type ChatsStorage = ReturnType<typeof chatsStorage>;
