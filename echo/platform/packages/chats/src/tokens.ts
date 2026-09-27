import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";

/**
 * The chat context budget in tokens. The Python router took 80% of the smallest input
 * window across the multi_modal_pro deployments; every Gemini flash model in those groups
 * accepts 1,048,576 input tokens, so the budget is fixed here instead of looked up.
 */
export const MAX_CHAT_CONTEXT_LENGTH = Math.floor(1_048_576 * 0.8);

let encoder: Tiktoken | null = null;

/**
 * Token count of one chat message, identical to litellm's token_counter for the Gemini
 * models: litellm has no Gemini tokenizer and falls back to tiktoken cl100k_base, adding
 * three tokens per message, one for the role and three to prime the reply. Keeping the
 * same numbers keeps stored tokens_count values, the context bar and the add-context
 * budget consistent with what the Python API computed.
 */
export function countMessageTokens(role: string, content: string): number {
  encoder ??= new Tiktoken(cl100k);
  return encoder.encode(content).length + encoder.encode(role).length + 6;
}
