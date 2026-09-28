import type { Models } from "@dembrane/llm";
import { generateText } from "ai";
import { renderPrompt } from "./prompts/render";

type Msg = { role: "system" | "user" | "assistant"; content: string };

/** One completion on a model group; returns the text, or null when the model sent none. */
export async function complete(
  models: Pick<Models, "model">,
  group: "text_fast" | "multi_modal_fast" | "multi_modal_pro",
  messages: Msg[],
  timeoutMs?: number,
): Promise<string | null> {
  const res = await generateText({
    model: models.model(group),
    messages,
    allowSystemInMessages: true,
    ...(timeoutMs !== undefined && { timeout: timeoutMs }),
  });
  return res.text ? res.text : null;
}

/**
 * A short chat title from the host's first message, on the fast group (generate_title).
 * Null for a message under two characters or when the model returns nothing. The prompt
 * is the English template with the target language passed in, as before.
 */
export async function generateTitle(
  models: Pick<Models, "model">,
  userQuery: string,
  language: string,
): Promise<string | null> {
  if (userQuery.trim().length < 2) return null;
  const prompt = renderPrompt("generate_chat_title", "en", {
    user_query: userQuery,
    language,
  });
  return complete(models, "multi_modal_fast", [{ role: "user", content: prompt }]);
}
