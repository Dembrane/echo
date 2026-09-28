import type { Db } from "@dembrane/db";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import type { ConversationsDeps } from "../deps";
import { v1Store } from "./storage";
import { conversationTranscript } from "./summary";

/**
 * litellm's token_counter for one user message on the Gemini model group. litellm has no
 * Gemini tokenizer, so it falls back to tiktoken's cl100k_base and adds the OpenAI chat
 * overhead: 3 tokens per message, 1 for the role, 3 for the reply priming. The counts
 * are what the dashboard has shown and stored, so they stay the same. Special-token text
 * counts as plain text (disallowed_special=()), as litellm encodes it.
 */
let encoder: Tiktoken | null = null;
const MESSAGE_OVERHEAD = 7;

export function countTokens(text: string): number {
  encoder ??= new Tiktoken(cl100k);
  return encoder.encode(text, [], []).length + MESSAGE_OVERHEAD;
}

/**
 * The token-count route's work after access: the stored count when there is one,
 * otherwise the count of the transcript, persisted only while the conversation still
 * reads as fully transcribed (a new chunk clears the column and the flag, and a stale
 * count must not outlive it). The Python kept a 500 second Redis layer in front; the
 * column alone answers here, which only costs a tokenisation on a cold read.
 */
export async function computeTokenCount(
  d: Pick<ConversationsDeps, "db" | "logger">,
  conversationId: string,
  now: () => Date = () => new Date(),
): Promise<number> {
  const store = v1Store(d.db);
  const conv = await store.conversation(conversationId);
  if (typeof conv?.token_count === "number") return conv.token_count;
  const count = countTokens(await conversationTranscript(store, conversationId));
  try {
    await persistIfTranscribed(d.db, conversationId, count, now());
  } catch (err) {
    d.logger.warn({ err, conversationId }, "failed to persist token_count");
  }
  return count;
}

async function persistIfTranscribed(db: Db, conversationId: string, count: number, now: Date) {
  const store = v1Store(db);
  const fresh = await store.conversation(conversationId);
  if (fresh?.is_all_chunks_transcribed)
    await store.updateConversation(conversationId, { token_count: count }, now);
}
