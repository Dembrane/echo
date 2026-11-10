import { withPayer } from "@dembrane/observability";
import { generateTitle as title } from "../src/llm";
import { reply as unscopedReply } from "../src/reply";
import { generateSuggestions as suggestions } from "../src/suggestions";
import { ensureConversationSummaries as summaries } from "../src/summaries";

// Each runs under /api/chats/:chat_id, whose middleware bills the chat.
const CHAT = { ref: "chat", id: "chat-under-test" } as const;

export const reply: typeof unscopedReply = (d, who, chatId, ...rest) =>
  withPayer({ ref: "chat", id: chatId }, () => unscopedReply(d, who, chatId, ...rest));

export const generateSuggestions: typeof suggestions = (d, projectId, chatId, ...rest) =>
  withPayer({ ref: "chat", id: chatId }, () => suggestions(d, projectId, chatId, ...rest));

export const generateTitle: typeof title = (...a) => withPayer(CHAT, () => title(...a));

export const ensureConversationSummaries: typeof summaries = (...a) =>
  withPayer(CHAT, () => summaries(...a));
