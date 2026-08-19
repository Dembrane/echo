/**
 * When the conversation actually started, for display purposes.
 *
 * `recording_started_at` is set on the first captured chunk; rows that
 * never got a chunk (and rows from before the column existed) fall back
 * to `created_at`. Sorting stays on `created_at`.
 */
export const getConversationStartTime = (
	conversation: Pick<Conversation, "created_at" | "recording_started_at">,
): string | null =>
	conversation.recording_started_at ?? conversation.created_at;
