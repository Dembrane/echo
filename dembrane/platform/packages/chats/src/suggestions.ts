import { generateText, Output } from "ai";
import { z } from "zod";
import type { ChatDeps, Suggestion } from "./deps";
import { renderPrompt } from "./prompts/render";

/**
 * Fresh chats: their inputs rarely change, so a short cache is enough.
 * Chats with history: the key carries the last reply and recent questions, so a new message
 * is a new key and an old entry can live long. Reopening a chat then costs no model call.
 */
const CACHE_TTL_MS = 180_000;
const HISTORY_CACHE_TTL_MS = 30 * 60_000;
/** Oldest entries go first, so the per-process cache cannot grow without bound. */
const CACHE_MAX_ENTRIES = 1000;

/**
 * Longest a suggestions call may take. Suggestions are a nicety, so a stalled model must
 * not hold the chat screen: past this the call answers an empty list.
 * Production timings: p90 12 s, 5% of successful calls exceed 15 s, 14 days to 2026-10-25.
 */
export const SUGGESTIONS_TIMEOUT_MS = 15_000;

const schema = z.object({
  suggestions: z.array(
    z.object({
      icon: z.enum(["sparkles", "search", "quote", "lightbulb", "list"]),
      label: z.string(),
      prompt: z.string(),
    }),
  ),
});

function cacheKey(
  mode: string,
  language: string,
  ids: string[],
  hasHistory: boolean,
  history: string,
) {
  const raw = [
    mode,
    language,
    hasHistory ? "True" : "False",
    [...ids].sort().join(","),
    history,
  ].join("|");
  const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 32);
  return `suggestions:${mode}:${hash}`;
}

/**
 * Up to three follow-up questions for a chat, from its conversations' summaries, the
 * last reply and recent questions (generate_suggestions). No mode, no context or any
 * failure (a stalled model included, after SUGGESTIONS_TIMEOUT_MS) answers an empty list:
 * suggestions are a nicety, never an error. Results are cached per chat state, see the
 * TTLs above.
 */
export async function generateSuggestions(
  d: ChatDeps,
  projectId: string,
  chatId: string,
  chatMode: string | null,
  language: string,
): Promise<Suggestion[]> {
  if (!chatMode) return [];
  try {
    const [lastResponse, recentQueries, conversations] = await Promise.all([
      d.store.lastAssistantMessage(chatId),
      d.store.recentUserQueries(projectId, chatId, 5),
      chatMode === "overview"
        ? d.reads.projectConversations(projectId)
        : d.store.lockedConversationsWithSummaries(chatId),
    ]);
    const hasHistory = Boolean(lastResponse || recentQueries.length);
    const key = cacheKey(
      chatMode,
      language,
      conversations.map((c) => String(c.id ?? "")),
      hasHistory,
      hasHistory ? JSON.stringify([lastResponse, recentQueries]) : "",
    );
    const ttl = hasHistory ? HISTORY_CACHE_TTL_MS : CACHE_TTL_MS;
    const hit = d.suggestionCache.get(key);
    if (hit && Date.now() - hit.at < ttl && hit.value.length) return hit.value;

    const summaries: string[] = [];
    for (const conv of conversations.slice(0, 10)) {
      const c = conv as { participant_name?: unknown; name?: unknown; summary?: unknown };
      const name = c.participant_name || c.name || "Participant";
      const summary = typeof c.summary === "string" ? c.summary : null;
      if (summary)
        summaries.push(
          `- ${name}: ${summary.length > 300 ? `${summary.slice(0, 300)}...` : summary}`,
        );
    }
    if (!summaries.length && !lastResponse && !recentQueries.length) return [];

    const system = renderPrompt("suggestions_system", language, {});
    const user = renderPrompt("suggestions_user", language, {
      chat_mode: chatMode,
      language,
      last_response: lastResponse,
      recent_queries: recentQueries,
      conversation_summaries: summaries,
      conversation_count: conversations.length,
    });
    const res = await generateText({
      model: d.models.model("multi_modal_fast"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      allowSystemInMessages: true,
      output: Output.object({ schema, name: "suggestions_response" }),
      timeout: d.suggestionTimeoutMs ?? SUGGESTIONS_TIMEOUT_MS,
    });
    const out = res.output.suggestions.slice(0, 3).map((s) => ({
      icon: s.icon,
      label: [...s.label].slice(0, 50).join(""),
      prompt: s.prompt,
    }));
    if (out.length) {
      d.suggestionCache.set(key, { at: Date.now(), value: out });
      while (d.suggestionCache.size > CACHE_MAX_ENTRIES) {
        const oldest = d.suggestionCache.keys().next().value;
        if (oldest === undefined) break;
        d.suggestionCache.delete(oldest);
      }
    }
    return out;
  } catch (err) {
    d.logger.warn({ err, chatId }, "suggestions failed");
    return [];
  }
}
