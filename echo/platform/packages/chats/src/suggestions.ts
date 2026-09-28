import { generateText, Output } from "ai";
import { z } from "zod";
import type { ChatDeps, Suggestion } from "./deps";
import { renderPrompt } from "./prompts/render";

const CACHE_TTL_MS = 180_000;

const schema = z.object({
  suggestions: z.array(
    z.object({
      icon: z.enum(["sparkles", "search", "quote", "lightbulb", "list"]),
      label: z.string(),
      prompt: z.string(),
    }),
  ),
});

function cacheKey(mode: string, language: string, ids: string[], hasHistory: boolean) {
  const raw = [mode, language, hasHistory ? "True" : "False", [...ids].sort().join(",")].join("|");
  const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 32);
  return `suggestions:${mode}:${hash}`;
}

/**
 * Up to three follow-up questions for a chat, from its conversations' summaries, the
 * last reply and recent questions (generate_suggestions). No mode, no context or any
 * failure answers an empty list: suggestions are a nicety, never an error. Fresh chats
 * (no history) are cached for three minutes because their inputs rarely change.
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
    );
    if (!hasHistory) {
      const hit = d.suggestionCache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS && hit.value.length) return hit.value;
    }

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
      timeout: 30_000,
    });
    const out = res.output.suggestions.slice(0, 3).map((s) => ({
      icon: s.icon,
      label: [...s.label].slice(0, 50).join(""),
      prompt: s.prompt,
    }));
    if (!hasHistory && out.length) d.suggestionCache.set(key, { at: Date.now(), value: out });
    return out;
  } catch (err) {
    d.logger.warn({ err, chatId }, "suggestions failed");
    return [];
  }
}
