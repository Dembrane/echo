import {
  freeLimitError,
  isFreeTier,
  projectAllowance,
  requireAccountBudget,
  requireAiBudget,
} from "@dembrane/allowance";
import { BadRequestError, NotFoundError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { FREE_TIER_MAX_SAMPLE_USER_TURNS } from "./tiers";

const {
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

export interface AdmitOptions {
  /** The caller already read the chat as live and in this project. */
  readonly chatChecked?: boolean;
  /** The workspace's own tier, when the caller read it (Access). */
  readonly tier?: string | null;
}

export interface FreeChats {
  canStartChat(projectId: string, now: Date, tier?: string | null): Promise<void>;
  admitTurn(turn: UserTurn, opts?: AdmitOptions): Promise<Admitted>;
  undoTurn(turn: UserTurn, admitted: Admitted): Promise<void>;
}

// Chats refuse at a used-up AI budget; a free sample keeps its own turn cap instead.
export function freeChats(db: Db): FreeChats {
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
  async function insertRows(q: Db, turn: UserTurn): Promise<boolean> {
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
  }

  // A transaction only when link rows go with the message.
  function insertMessage(turn: UserTurn): Promise<boolean> {
    if (!turn.usedConversationIds?.length && !turn.addedConversationIds?.length)
      return insertRows(db, turn);
    return db.transaction((q) => insertRows(q as unknown as Db, turn));
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
    canStartChat(projectId, now, tier) {
      return requireAiBudget(db, projectId, now, tier);
    },

    async admitTurn(turn, opts = {}) {
      if (!opts.chatChecked) await requireChat(turn);
      // Paid accounts have no budget and no sample cap.
      const { account, sample } =
        opts.tier && !isFreeTier(opts.tier)
          ? { account: null, sample: false }
          : await projectAllowance(db, turn.projectId, turn.now);
      if (account && !sample) await requireAccountBudget(db, account, turn.now);
      if (await stored(turn)) return { inserted: false };
      if (account && sample) {
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
