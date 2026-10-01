import type { JobDefinition } from "@dembrane/queue";
import {
  catchUpSummaries,
  finalizeConversation,
  finishConversation,
  finishIdleConversations,
  processChunk,
  summarizeConversation,
} from "./pipeline/defs";

export {
  catchUpSummaries,
  finalizeConversation,
  finishConversation,
  finishIdleConversations,
  processChunk,
  summarizeConversation,
};

/** What the API enqueues. */
export const conversationApiJobs: readonly JobDefinition[] = [
  processChunk,
  finishConversation,
  finalizeConversation,
  summarizeConversation,
];
