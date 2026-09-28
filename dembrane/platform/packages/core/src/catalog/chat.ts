import type { Codes } from "./types";

export const chat = {
  "chat.not_found": {
    action: "none",
    detail: "Chat not found",
    description: "The chat does not exist, was deleted, or the caller cannot see it.",
  },
  "chat.verify_unavailable": {
    action: "retry",
    detail: "Could not verify the chat for this request. Please try again.",
    description: "Reading the chat to check its project failed; nothing was done.",
  },
  "chat.project_required": {
    action: "none",
    detail: "project_id is required to read this chat",
    audience: "developer",
    description: "A project-scoped read of a chat came without project_id.",
  },
  "chat.project_mismatch": {
    action: "none",
    detail: "project_id does not match this chat",
    audience: "developer",
    description: "The project_id sent is not the chat's project.",
  },
  "chat.context_size_unavailable": {
    action: "retry",
    detail: "Could not compute chat context size. Please try again.",
    description: "Counting the tokens of the chat's conversations failed.",
  },
  "chat.agentic_endpoint_required": {
    action: "none",
    detail: "Agentic chats must use /api/agentic endpoints",
    audience: "developer",
    description: "A classic chat endpoint was called for an agentic chat.",
  },
  "chat.context_target_required": {
    action: "none",
    detail: "One of conversation_id, conversation_ids or select_all is required",
    audience: "developer",
    description: "Adding context named no conversation.",
  },
  "chat.context_target_ambiguous": {
    action: "none",
    detail: "Only one of conversation_id, conversation_ids or select_all can be provided",
    audience: "developer",
    description: "Adding context named conversations in more than one way.",
  },
  "chat.select_all_needs_project": {
    action: "none",
    detail: "project_id is required when select_all is True",
    audience: "developer",
    description: "select_all was sent without the project to select from.",
  },
  "chat.conversation_ids_need_project": {
    action: "none",
    detail: "project_id is required when conversation_ids is provided",
    audience: "developer",
    description: "conversation_ids was sent without their project.",
  },
  "chat.conversation_ids_empty": {
    action: "fix_input",
    detail: "conversation_ids cannot be empty",
    description: "Adding context with an empty selection of conversations.",
  },
  "chat.too_many_conversations": {
    action: "fix_input",
    detail: "Cannot add more than {max} conversations at once",
    description: "More conversations were added to a chat in one go than the limit allows.",
  },
  "chat.conversation_already_added": {
    action: "none",
    detail: "Conversation already in the chat",
    description: "The conversation is already part of the chat's context.",
  },
  "chat.conversation_too_long": {
    action: "none",
    detail: "Conversation is too long",
    description: "The conversation alone is longer than a chat's context can hold.",
  },
  "chat.context_full": {
    action: "fix_input",
    detail: "Chat context is too long. Remove other conversations to proceed.",
    description: "Adding the conversation would overflow the chat's context.",
  },
  "chat.conversation_not_in_chat": {
    action: "none",
    detail: "Conversation not found in the chat",
    description: "The conversation to remove is not part of the chat's context.",
  },
  "chat.mode_already_set": {
    action: "none",
    detail: "Chat mode is already set to '{mode}'. Start a new chat to use a different mode.",
    description: "The chat's mode is fixed once chosen.",
  },
} as const satisfies Codes<"chat">;
