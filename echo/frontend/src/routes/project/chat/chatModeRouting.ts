import type { ChatMode } from "@/lib/api";

/**
 * Which screen a chat opens on, given what the server knows about it.
 *
 * Pulled out of ProjectChatRoute because the consequences are one-way: the
 * server's initialize-mode refuses to change a chat's mode once it is set, so
 * picking a mode on the host's behalf can never be undone. Production still
 * has thousands of chats with chat_mode NULL, several hundred of them with a
 * real message history, and an automatic agentic init would move those threads
 * behind a panel that reads a different message store.
 */
export type ChatScreen =
	/** Set the mode to agentic without asking, then hand off to the panel. */
	| "agentic-auto"
	/** Ask the host which mode this chat should be. */
	| "mode-picker"
	/** Render the message thread. */
	| "thread";

export type ChatScreenDecision = {
	screen: ChatScreen;
	/**
	 * The mode the thread renders as. `null` means the chat never picked one
	 * and nothing should write one: it renders like Specific Details, which is
	 * what its existing messages were produced by.
	 */
	chatMode: ChatMode | null;
};

export const resolveChatScreen = ({
	rawChatMode,
	hasLockedConversations,
	messageCount,
	agenticIsDefault,
}: {
	rawChatMode: ChatMode | null | undefined;
	hasLockedConversations: boolean;
	messageCount: number;
	agenticIsDefault: boolean;
}): ChatScreenDecision => {
	if (rawChatMode != null) {
		return { chatMode: rawChatMode, screen: "thread" };
	}

	// Locked conversations are the older legacy marker: a chat that locked
	// context predates chat_mode and has always rendered as Specific Details.
	if (hasLockedConversations) {
		return { chatMode: "deep_dive", screen: "thread" };
	}

	// Messages are the same signal by a different route: this thread came from
	// the pre-mode /chats/{id} path. Show it, and do not offer a mode, because
	// choosing agentic here would hide it.
	if (messageCount > 0) {
		return { chatMode: null, screen: "thread" };
	}

	// Nothing written yet, so there is nothing to lose either way. Availability
	// is not default-ness: only auto-assign when agentic is the default.
	return {
		chatMode: null,
		screen: agenticIsDefault ? "agentic-auto" : "mode-picker",
	};
};
