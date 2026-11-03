import { allowanceForProject, freeLimitError, requireAiBudget } from "@dembrane/allowance";
import { BadRequestError, NotFoundError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { FREE_TIER_MAX_SAMPLE_USER_TURNS } from "./tiers";

const {
  project,
  project_chat,
  project_chat_message,
  project_chat_message_conversation,
  project_chat_message_conversation_1,
} = schema;

export interface UserTurn {
  readonly projectId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly now: Date;
  readonly templateKey?: string | null;
  readonly usedConversationIds?: readonly string[];
  readonly addedConversationIds?: readonly string[];
}

// False when the message id was already stored, so undo must not delete it.
export type Admitted = { readonly inserted: boolean };

export interface FreeChats {
  canStartChat(projectId: string, now: Date): Promise<void>;
  admitTurn(turn: UserTurn): Promise<Admitted>;
  undoTurn(turn: UserTurn, admitted: Admitted): Promise<void>;
}

// Chats refuse at a used-up AI budget; a free sample keeps its own turn cap instead.
export function freeChats(db: Db): FreeChats {
  async function isFreeSample(turn: UserTurn): Promise<boolean> {
    const [row] = await db
      .select({ is_sample: project.is_sample })
      .from(project)
      .where(eq(project.id, turn.projectId));
    if (row?.is_sample !== true) return false;
    return (await allowanceForProject(db, turn.projectId, turn.now)) !== null;
  }

  async function requireChat(turn: UserTurn): Promise<void> {
    const [chat] = await db
      .select({ id: project_chat.id })
      .from(project_chat)
      .where(
        and(
          eq(project_chat.id, turn.chatId),
          eq(project_chat.project_id, turn.projectId),
          isNull(project_chat.deleted_at),
        ),
      );
    if (!chat) throw new NotFoundError("chat.not_found");
  }

  // A retry with the same message id is a no-op, as in storage.createMessage.
  function insertMessage(turn: UserTurn): Promise<boolean> {
    return db.transaction(async (q) => {
      const inserted = await q
        .insert(project_chat_message)
        .values({
          id: turn.messageId,
          project_chat_id: turn.chatId,
          message_from: "user",
          text: turn.text,
          template_key: turn.templateKey ?? null,
          date_created: turn.now.toISOString(),
          date_updated: null,
        })
        .onConflictDoNothing({ target: project_chat_message.id })
        .returning({ id: project_chat_message.id });
      if (inserted.length === 0) return false;
      const link = (ids: readonly string[] | undefined) =>
        (ids ?? []).map((conversation_id) => ({
          project_chat_message_id: turn.messageId,
          conversation_id,
        }));
      const used = link(turn.usedConversationIds);
      const added = link(turn.addedConversationIds);
      if (used.length > 0) await q.insert(project_chat_message_conversation).values(used);
      if (added.length > 0) await q.insert(project_chat_message_conversation_1).values(added);
      return true;
    });
  }

  // True when the id is already stored in this chat; an id from another chat is refused.
  async function stored(turn: UserTurn): Promise<boolean> {
    const [row] = await db
      .select({ chatId: project_chat_message.project_chat_id })
      .from(project_chat_message)
      .where(eq(project_chat_message.id, turn.messageId));
    if (!row) return false;
    if (row.chatId !== turn.chatId) throw new BadRequestError("request.invalid");
    return true;
  }

  async function sampleTurns(projectId: string): Promise<number> {
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
  }

  return {
    canStartChat(projectId, now) {
      return requireAiBudget(db, projectId, now);
    },

    async admitTurn(turn) {
      await requireChat(turn);
      // A no-op for paid accounts and samples.
      await requireAiBudget(db, turn.projectId, turn.now);
      if (await stored(turn)) return { inserted: false };
      if (await isFreeSample(turn)) {
        const used = await sampleTurns(turn.projectId);
        if (used >= FREE_TIER_MAX_SAMPLE_USER_TURNS)
          throw freeLimitError("chat_turns", { used, cap: FREE_TIER_MAX_SAMPLE_USER_TURNS });
      }
      return { inserted: await insertMessage(turn) };
    },

    async undoTurn(turn, admitted) {
      if (!admitted.inserted) return;
      await db
        .delete(project_chat_message)
        .where(
          and(
            eq(project_chat_message.id, turn.messageId),
            eq(project_chat_message.project_chat_id, turn.chatId),
          ),
        );
    },
  };
}
