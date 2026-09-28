import { BadRequestError, NotFoundError, PaymentRequiredError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { chatFor, chatProjectId } from "./access";
import {
  type ChatContext,
  chatContext,
  conversationTokenCount,
  conversationTokenCounts,
} from "./context";
import type { ChatDeps, Suggestion } from "./deps";
import type { ChatRow, Row } from "./storage";
import { generateSuggestions } from "./suggestions";
import { ensureConversationSummaries } from "./summaries";
import { conversationIsLocked } from "./tiers";
import { MAX_CHAT_CONTEXT_LENGTH } from "./tokens";

/** Upper bound on one add-context batch, for select_all and for an explicit pick. */
export const MAX_ADD_CONTEXT_CONVERSATIONS = 1000;

const SUGGESTIONS_LIMIT = { name: "chat_suggestions", capacity: 10, windowSeconds: 60 };

/** A caller-supplied project_id must be the chat's own (reads below are not tenant-scoped). */
function assertProjectMatches(chat: ChatRow, projectId: string | null) {
  if (projectId !== null && projectId !== chatProjectId(chat))
    throw new BadRequestError("chat.project_mismatch");
}

const gate = (d: ChatDeps) => ({ access: d.access, store: d.store });

// ── delete ────────────────────────────────────────────────────────────

export async function deleteChat(d: ChatDeps, who: Signed, chatId: string) {
  await chatFor(gate(d), who, chatId, { require: "project:update" });
  const now = d.now();
  // Python's datetime.utcnow().isoformat(): a naive timestamp, read by Postgres as UTC.
  await d.store.softDeleteChat(chatId, now.toISOString().replace("Z", ""), now, who.directusUserId);
  return { status: "success" };
}

// ── context ───────────────────────────────────────────────────────────

export async function getContext(d: ChatDeps, who: Signed, chatId: string): Promise<ChatContext> {
  const { chat } = await chatFor(gate(d), who, chatId, { withUsed: true });
  return chatContext(d, who, chat);
}

interface Result {
  conversation_id: string;
  participant_name: string;
  success: boolean;
  reason: string | null;
}

const result = (id: string, name: string, success: boolean, reason: string): Result => ({
  conversation_id: id,
  participant_name: name,
  success,
  reason,
});

/**
 * Attaches as many candidates as the chat can take, in order, walking the token budget
 * once. Agentic chats preload nothing, so they skip the budget.
 */
async function attachWithinBudget(
  d: ChatDeps,
  who: Signed,
  chat: ChatRow,
  projectId: string,
  candidates: Row[],
  extraSkipped: Result[] = [],
) {
  const enforce = chat.chat_mode !== "agentic";
  const existing = new Set(
    (chat.used_conversations ?? []).map((l) => l.conversation_id?.id).filter(Boolean),
  );
  let usage = 0;
  if (enforce) {
    const ctx = await chatContext(d, who, chat);
    usage = ctx.conversations.reduce((a, c) => a + c.token_usage, 0);
  }
  const tier = await d.reads.projectTier(projectId);
  const ids = candidates.map((c) => c.id as string).filter(Boolean);
  const hasContent = await d.reads.withContent(ids);
  let counts = new Map<string, number>();
  if (enforce) {
    const need = candidates
      .filter(
        (c) =>
          c.id &&
          !existing.has(c.id as string) &&
          hasContent.has(c.id as string) &&
          !conversationIsLocked(c, tier),
      )
      .map((c) => c.id as string);
    counts = await conversationTokenCounts(d, who, need, projectId);
  }

  let added: Result[] = [];
  const skipped: Result[] = [...extraSkipped];
  let limitReached = false;
  const toAttach: string[] = [];
  for (const c of candidates) {
    const id = c.id as string | undefined;
    if (!id) continue;
    const name = String(c.participant_name || "Unknown");
    if (conversationIsLocked(c, tier)) {
      skipped.push(result(id, name, false, "locked"));
      continue;
    }
    if (existing.has(id)) {
      skipped.push(result(id, name, false, "already_in_context"));
      continue;
    }
    if (!hasContent.has(id)) {
      skipped.push(result(id, name, false, "empty"));
      continue;
    }
    if (enforce) {
      if (limitReached) {
        skipped.push(result(id, name, false, "context_limit_reached"));
        continue;
      }
      const tokens = counts.get(id);
      if (tokens === undefined) {
        skipped.push(result(id, name, false, "error"));
        continue;
      }
      if (tokens > MAX_CHAT_CONTEXT_LENGTH) {
        skipped.push(result(id, name, false, "too_long"));
        continue;
      }
      const share = tokens / MAX_CHAT_CONTEXT_LENGTH;
      if (usage + share > 1) {
        limitReached = true;
        skipped.push(result(id, name, false, "context_limit_reached"));
        continue;
      }
      usage += share;
    }
    existing.add(id);
    toAttach.push(id);
    added.push(result(id, name, true, "added"));
  }

  if (toAttach.length) {
    try {
      await d.store.attachConversations(chat.id, toAttach);
    } catch (err) {
      d.logger.warn({ err, chatId: chat.id }, "bulk attach failed");
      const snapshot = added;
      const failed = new Set(toAttach);
      added = added.filter((a) => !failed.has(a.conversation_id));
      for (const cid of toAttach)
        skipped.push(
          result(
            cid,
            snapshot.find((a) => a.conversation_id === cid)?.participant_name ?? "Unknown",
            false,
            "error",
          ),
        );
    }
  }
  return {
    added,
    skipped,
    total_processed: candidates.length + extraSkipped.length,
    context_limit_reached: limitReached,
  };
}

export interface AddContextBody {
  conversation_id: string | null;
  conversation_ids: string[] | null;
  select_all: boolean | null;
  project_id: string | null;
  tag_ids: string[] | null;
  verified_only: boolean | null;
  search_text: string | null;
}

const EMPTY_ADD = {
  added: null,
  skipped: null,
  total_processed: null,
  context_limit_reached: null,
};

export async function addContext(d: ChatDeps, who: Signed, chatId: string, body: AddContextBody) {
  const { chat } = await chatFor(gate(d), who, chatId, { withUsed: true });
  assertProjectMatches(chat, body.project_id);
  const projectId = body.project_id || chatProjectId(chat);
  const given = [body.conversation_id, body.conversation_ids, body.select_all].filter(
    (v) => v !== null,
  ).length;
  if (given === 0) throw new BadRequestError("chat.context_target_required");
  if (given > 1) throw new BadRequestError("chat.context_target_ambiguous");

  if (body.select_all === true) {
    if (!projectId) throw new BadRequestError("chat.select_all_needs_project");
    const all = await d.reads.listWithFilters({
      projectId,
      tagIds: body.tag_ids,
      verifiedOnly: body.verified_only ?? false,
      search: body.search_text,
      limit: MAX_ADD_CONTEXT_CONVERSATIONS,
    });
    return attachWithinBudget(d, who, chat, projectId, all);
  }

  if (body.conversation_ids !== null) {
    if (!projectId) throw new BadRequestError("chat.conversation_ids_need_project");
    const requested: string[] = [];
    for (const id of body.conversation_ids) if (id && !requested.includes(id)) requested.push(id);
    if (!requested.length) throw new BadRequestError("chat.conversation_ids_empty");
    if (requested.length > MAX_ADD_CONTEXT_CONVERSATIONS)
      throw new BadRequestError("chat.too_many_conversations", {
        params: { max: MAX_ADD_CONTEXT_CONVERSATIONS },
      });
    const found = await d.reads.listWithFilters({
      projectId,
      ids: requested,
      limit: requested.length,
    });
    const byId = new Map(found.map((c) => [c.id as string, c]));
    const candidates = requested.filter((id) => byId.has(id)).map((id) => byId.get(id) as Row);
    const notFound = requested
      .filter((id) => !byId.has(id))
      .map((id) => result(id, "Unknown", false, "not_found"));
    return attachWithinBudget(d, who, chat, projectId, candidates, notFound);
  }

  if (body.conversation_id !== null) {
    const conv = await d.reads.liveConversation(body.conversation_id);
    // Spec H-4: the conversation must belong to the chat's project in every mode, or a
    // foreign conversation's row and participant name leak into the chat and its prompt.
    if (!conv || conv.project_id !== chatProjectId(chat))
      throw new NotFoundError("conversation.not_found");
    if (projectId && conv.is_over_cap) {
      const tier = await d.reads.projectTier(projectId);
      if (conversationIsLocked(conv, tier))
        throw new PaymentRequiredError("conversation.locked", {
          details: {
            error: "conversation_locked",
            message: "Conversation is locked, upgrade to add it to a chat.",
          },
        });
    }
    const existing = new Set((chat.used_conversations ?? []).map((l) => l.conversation_id?.id));
    if (existing.has(body.conversation_id))
      throw new BadRequestError("chat.conversation_already_added");
    if (chat.chat_mode !== "agentic") {
      const tokens = await conversationTokenCount(d, body.conversation_id);
      if (tokens > MAX_CHAT_CONTEXT_LENGTH) throw new BadRequestError("chat.conversation_too_long");
      const ctx = await chatContext(d, who, chat);
      const usage = ctx.conversations.reduce((a, c) => a + c.token_usage, 0);
      if (usage + tokens / MAX_CHAT_CONTEXT_LENGTH > 1)
        throw new BadRequestError("chat.context_full");
    }
    await d.store.attachConversations(chat.id, [body.conversation_id]);
  }
  return EMPTY_ADD;
}

export async function deleteContext(
  d: ChatDeps,
  who: Signed,
  chatId: string,
  conversationId: string,
) {
  await chatFor(gate(d), who, chatId);
  const ctx = await getContext(d, who, chatId);
  const entry = ctx.conversations.find((c) => c.conversation_id === conversationId);
  if (!entry) throw new NotFoundError("chat.conversation_not_in_chat");
  if (entry.locked) throw new BadRequestError("conversation.locked");
  await d.store.detachConversation(chatId, conversationId);
  return null;
}

/**
 * Marks the conversations added since the last message as used, with a "dembrane" message
 * saying how many, and returns every conversation in the context with its tags.
 */
export async function lockConversations(d: ChatDeps, who: Signed, chatId: string) {
  await chatFor(gate(d), who, chatId);
  const messages = await d.store.messages(chatId, { withRelations: true, order: "desc" });
  const already = new Set<string>();
  for (const m of messages)
    for (const rel of (m.used_conversations as { conversation_id: { id: string } | null }[]) ?? [])
      if (rel.conversation_id?.id) already.add(rel.conversation_id.id);
  const ctx = await getContext(d, who, chatId);
  const toAdd = [...new Set(ctx.conversation_id_list)].filter((id) => !already.has(id));
  if (toAdd.length) {
    const text =
      toAdd.length > 1
        ? `You added ${toAdd.length} conversations as context to the chat.`
        : "You added 1 conversation as context to the chat.";
    await d.store.createMessage({
      id: d.newId(),
      chatId,
      from: "dembrane",
      text,
      now: d.now(),
      usedConversationIds: toAdd,
      addedConversationIds: toAdd,
    });
  }
  return d.reads.listByIds(ctx.conversation_id_list);
}

// ── suggestions and mode ──────────────────────────────────────────────

export async function suggestions(
  d: ChatDeps,
  who: Signed,
  chatId: string,
  language: string,
): Promise<{ suggestions: Suggestion[] }> {
  const { chat } = await chatFor(gate(d), who, chatId);
  const projectId = chatProjectId(chat);
  if (!projectId) return { suggestions: [] };
  await d.limiter.check(SUGGESTIONS_LIMIT, projectId);
  return {
    suggestions: await generateSuggestions(d, projectId, chatId, chat.chat_mode, language),
  };
}

export async function initializeMode(
  d: ChatDeps,
  who: Signed,
  chatId: string,
  body: { mode: "overview" | "deep_dive" | "agentic"; project_id: string },
) {
  const { chat } = await chatFor(gate(d), who, chatId, { withUsed: true });
  assertProjectMatches(chat, body.project_id);
  if (chat.chat_mode !== null)
    throw new BadRequestError("chat.mode_already_set", {
      params: { mode: String(chat.chat_mode) },
    });
  if (body.mode === "deep_dive") {
    await d.store.setChatMode(chatId, "deep_dive", d.now(), who.directusUserId);
    return {
      chat_mode: "deep_dive",
      conversations_added: 0,
      conversations_summarized: 0,
      message: "Deep dive mode enabled. Select the conversations you want to analyze.",
    };
  }
  if (body.mode === "agentic") {
    await d.store.setChatMode(chatId, "agentic", d.now(), who.directusUserId);
    return {
      chat_mode: "agentic",
      conversations_added: 0,
      conversations_summarized: 0,
      message: "Agentic mode enabled. Use the agentic run APIs for messaging.",
    };
  }
  const withContent = (await d.reads.overviewConversations(body.project_id)).filter(
    (c) => Number(c.chunks_count ?? 0) > 0,
  );
  let newly = 0;
  if (withContent.length) {
    const res = await ensureConversationSummaries(
      d,
      withContent.map((c) => c.id as string),
    );
    newly = res.succeeded.length - withContent.filter((c) => c.summary).length;
  }
  await d.store.setChatMode(chatId, "overview", d.now(), who.directusUserId);
  if (!withContent.length)
    return {
      chat_mode: "overview",
      conversations_added: 0,
      conversations_summarized: 0,
      message: "Overview mode enabled. No conversations found yet.",
    };
  return {
    chat_mode: "overview",
    conversations_added: withContent.length,
    conversations_summarized: Math.max(0, newly),
    message: `Overview mode enabled with ${withContent.length} conversations.`,
  };
}
