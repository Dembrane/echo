import { UnavailableError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectAllows } from "@dembrane/projects";
import type { ChatDeps } from "./deps";
import type { ChatRow } from "./storage";
import { countMessageTokens, MAX_CHAT_CONTEXT_LENGTH } from "./tokens";

/** A conversation's transcript: its chunks' text in timestamp order, blank chunks skipped. */
export async function conversationTranscript(d: ChatDeps, conversationId: string) {
  const chunks = await d.reads.transcriptChunks(conversationId);
  return chunks
    .map((c) => c.transcript)
    .filter((t): t is string => Boolean(t))
    .join("\n");
}

/**
 * Token count of one conversation's transcript. The stored column is the durable cache
 * (cleared whenever transcript text changes); a computed count is stored only while the
 * transcript is complete, so a count can never outlive a new chunk.
 */
export async function conversationTokenCount(d: ChatDeps, conversationId: string) {
  const conv = await d.reads.liveConversation(conversationId);
  if (!conv) throw new Error(`conversation ${conversationId} not found`);
  if (typeof conv.token_count === "number") return conv.token_count;
  const count = countMessageTokens("user", await conversationTranscript(d, conversationId));
  await d.reads.persistTokenCount(conversationId, count, d.now());
  return count;
}

/**
 * Counts for many conversations. The stored column is trusted only for live rows of the
 * chat's own project; anything else is counted on the per-conversation path, which
 * re-checks that the caller may read it. Failed ids are left out and callers decide.
 */
export async function conversationTokenCounts(
  d: ChatDeps,
  who: Signed,
  ids: readonly string[],
  projectId: string,
): Promise<Map<string, number>> {
  const out = await d.reads.storedTokenCounts(ids, projectId);
  const rest = ids.filter((id) => !out.has(id));
  // Bounded, as before: a cold select-all must not open hundreds of reads at once.
  for (let i = 0; i < rest.length; i += 10) {
    await Promise.all(
      rest.slice(i, i + 10).map(async (id) => {
        try {
          if (!who.isStaff) {
            const conv = await d.reads.liveConversation(id);
            const pid = typeof conv?.project_id === "string" ? conv.project_id : null;
            if (!pid || !(await projectAllows(d.access, who, pid, "conversation:read")))
              throw new Error("not readable");
          }
          out.set(id, await conversationTokenCount(d, id));
        } catch (err) {
          d.logger.warn({ err, conversationId: id }, "token count failed");
        }
      }),
    );
  }
  return out;
}

export interface ChatContext {
  conversations: {
    conversation_id: string;
    conversation_participant_name: string;
    locked: boolean;
    token_usage: number;
  }[];
  messages: { role: "user" | "assistant"; token_usage: number }[];
  conversation_id_list: string[];
  locked_conversation_id_list: string[];
  chat_mode: string | null;
}

/**
 * GET /api/chats/{id}/context: the context bar. A conversation is locked once a message
 * used it; message tokens are counted and stored on first read. `chat` must carry its
 * used conversations.
 */
export async function chatContext(d: ChatDeps, who: Signed, chat: ChatRow): Promise<ChatContext> {
  const messages = await d.store.messages(chat.id, { withRelations: true, order: "asc" });
  const locked = new Set<string>();
  let user = 0;
  let assistant = 0;
  for (const m of messages) {
    for (const rel of (m.used_conversations as { conversation_id: { id: string } | null }[]) ??
      []) {
      if (rel.conversation_id?.id) locked.add(rel.conversation_id.id);
    }
    const from = m.message_from;
    if (from !== "user" && from !== "assistant") continue;
    let tokens = m.tokens_count as number | null;
    if (tokens === null || tokens === undefined) {
      tokens = countMessageTokens(from, (m.text as string | null) ?? "");
      try {
        await d.store.updateMessage(m.id as string, { tokens_count: tokens }, d.now());
      } catch (err) {
        d.logger.warn({ err, messageId: m.id }, "token count not stored");
      }
    }
    if (from === "user") user += tokens;
    else assistant += tokens;
  }

  const ctx: ChatContext = {
    conversations: [],
    conversation_id_list: [],
    locked_conversation_id_list: [],
    messages: [
      { role: "user", token_usage: user / MAX_CHAT_CONTEXT_LENGTH },
      { role: "assistant", token_usage: assistant / MAX_CHAT_CONTEXT_LENGTH },
    ],
    chat_mode: chat.chat_mode,
  };

  const meta: [string, string, boolean][] = [];
  for (const link of chat.used_conversations ?? []) {
    const ref = link.conversation_id;
    if (!ref?.id) continue;
    meta.push([ref.id, String(ref.participant_name ?? ""), locked.has(ref.id)]);
  }
  let counts = new Map<string, number>();
  if (meta.length) {
    counts = await conversationTokenCounts(
      d,
      who,
      meta.map(([id]) => id),
      chat.project_id?.id ?? "",
    );
    // Fail closed: a missing count would read as zero and let add-context pass the limit.
    if (meta.some(([id]) => !counts.has(id)))
      throw new UnavailableError("Could not compute chat context size. Please try again.");
  }
  for (const [id, name, isLocked] of meta) {
    ctx.conversations.push({
      conversation_id: id,
      conversation_participant_name: name,
      locked: isLocked,
      token_usage: (counts.get(id) ?? 0) / MAX_CHAT_CONTEXT_LENGTH,
    });
    ctx.conversation_id_list.push(id);
    if (isLocked) ctx.locked_conversation_id_list.push(id);
  }
  return ctx;
}
