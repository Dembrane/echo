import {
  type AllowanceAccount,
  allowanceForCountedProject,
  allowanceForProject,
  freeLimitError,
  freeLimits,
  giveBack,
  take,
  usedThisPeriod,
  withAllowanceLock,
} from "@dembrane/allowance";
import { BadRequestError, NotFoundError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { and, count, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
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

export interface Admitted {
  readonly account: AllowanceAccount | null;
  readonly claimed: boolean;
  // False when the message id was already stored, so undo must not delete it.
  readonly inserted?: boolean;
}

export interface FreeTurns {
  readonly limit: number;
  readonly used: number;
  readonly frozen: boolean;
}

export interface FreeChats {
  canStartChat(projectId: string, now: Date): Promise<void>;
  admitTurn(turn: UserTurn): Promise<Admitted>;
  undoTurn(turn: UserTurn, admitted: Admitted): Promise<void>;
  turnStatus(chatId: string, projectId: string, now: Date): Promise<FreeTurns | null>;
}

// Free chats: a monthly slot claimed at a chat's first user turn, then a per-chat turn cap.
export function freeChats(db: Db): FreeChats {
  // admitTurn still needs the account for samples (their own turn cap on free).
  async function isSample(projectId: string): Promise<boolean> {
    const [row] = await db
      .select({ is_sample: project.is_sample })
      .from(project)
      .where(eq(project.id, projectId));
    return row?.is_sample === true;
  }

  // A retry with the same message id is a no-op, as in storage.createMessage.
  async function insertMessage(q: Db, turn: UserTurn): Promise<boolean> {
    const at = turn.now.toISOString();
    const inserted = await q
      .insert(project_chat_message)
      .values({
        id: turn.messageId,
        project_chat_id: turn.chatId,
        message_from: "user",
        text: turn.text,
        template_key: turn.templateKey ?? null,
        date_created: at,
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

  // True when the id is already stored in this chat; an id from another chat is refused.
  async function stored(q: Db, turn: UserTurn): Promise<boolean> {
    const [row] = await q
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

  async function turnsSince(q: Db, chatId: string, since: Date): Promise<number> {
    const [row] = await q
      .select({ n: count() })
      .from(project_chat_message)
      .where(
        and(
          eq(project_chat_message.project_chat_id, chatId),
          eq(project_chat_message.message_from, "user"),
          gte(project_chat_message.date_created, since.toISOString()),
        ),
      );
    return Number(row?.n ?? 0);
  }

  // The chat's stamp and whether it is this period's.
  const stampOf = (a: AllowanceAccount) => ({
    stamped: isNotNull(project_chat.free_period_start),
    current: sql<boolean>`${project_chat.free_period_start} = ${a.periodStart.toISOString()}::timestamptz`,
  });

  return {
    async canStartChat(projectId, now) {
      const a = await allowanceForCountedProject(db, projectId, now);
      if (!a) return;
      const limits = await freeLimits(db);
      const used = (await usedThisPeriod(db, a)).chats;
      if (used >= limits.chats_month)
        throw freeLimitError("chats", { used, cap: limits.chats_month });
    },

    async admitTurn(turn) {
      const account = await allowanceForProject(db, turn.projectId, turn.now);
      if (!account) {
        if (await stored(db, turn)) return { account: null, claimed: false, inserted: false };
        const inserted = await insertMessage(db, turn);
        return { account: null, claimed: false, inserted };
      }
      if (await isSample(turn.projectId)) {
        if (await stored(db, turn)) return { account, claimed: false, inserted: false };
        const used = await sampleTurns(turn.projectId);
        if (used >= FREE_TIER_MAX_SAMPLE_USER_TURNS)
          throw freeLimitError("chat_turns", { used, cap: FREE_TIER_MAX_SAMPLE_USER_TURNS });
        const inserted = await insertMessage(db, turn);
        return { account, claimed: false, inserted };
      }
      const limits = await freeLimits(db);
      return withAllowanceLock(db, account, async (tx) => {
        const [chat] = await tx
          .select(stampOf(account))
          .from(project_chat)
          .where(
            and(
              eq(project_chat.id, turn.chatId),
              eq(project_chat.project_id, turn.projectId),
              isNull(project_chat.deleted_at),
            ),
          )
          .for("update");
        if (!chat) throw new NotFoundError("chat.not_found");
        if (await stored(tx, turn)) return { account, claimed: false, inserted: false };
        let claimed = false;
        if (!chat.stamped) {
          const t = await take(tx, account, "chats", 1, limits.chats_month);
          if (!t.ok) throw freeLimitError("chats", { used: t.used, cap: t.limit });
          await tx
            .update(project_chat)
            .set({ free_period_start: account.periodStart.toISOString() })
            .where(eq(project_chat.id, turn.chatId));
          claimed = true;
        } else if (!chat.current) {
          throw freeLimitError("chat_turns", { reason: "frozen" });
        }
        const used = await turnsSince(tx, turn.chatId, account.periodStart);
        const cap = limits.chat_turns_per_chat;
        if (used >= cap) throw freeLimitError("chat_turns", { used, cap });
        const inserted = await insertMessage(tx, turn);
        return { account, claimed, inserted };
      });
    },

    async undoTurn(turn, admitted) {
      if (admitted.inserted === false) return;
      await db
        .delete(project_chat_message)
        .where(
          and(
            eq(project_chat_message.id, turn.messageId),
            eq(project_chat_message.project_chat_id, turn.chatId),
          ),
        );
      const a = admitted.account;
      if (!a || !admitted.claimed) return;
      await withAllowanceLock(db, a, async (tx) => {
        const cleared = await tx
          .update(project_chat)
          .set({ free_period_start: null })
          .where(and(eq(project_chat.id, turn.chatId), stampOf(a).current))
          .returning({ id: project_chat.id });
        if (cleared.length > 0) await giveBack(tx, a, "chats", 1);
      });
    },

    async turnStatus(chatId, projectId, now) {
      const a = await allowanceForCountedProject(db, projectId, now);
      if (!a) return null;
      const [chat] = await db
        .select(stampOf(a))
        .from(project_chat)
        .where(eq(project_chat.id, chatId));
      if (!chat?.stamped) return null;
      const limits = await freeLimits(db);
      return {
        limit: limits.chat_turns_per_chat,
        used: await turnsSince(db, chatId, a.periodStart),
        frozen: !chat.current,
      };
    },
  };
}
