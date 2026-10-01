import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const chat = {
	"chat.context_full": msg({
		id: "error.chat.context_full",
		message:
			"This chat is full. Remove some conversations to make room for this one.",
	}),
	"chat.context_size_unavailable": msg({
		id: "error.chat.context_size_unavailable",
		message:
			"We could not work out how much this chat holds just now. Try again in a moment.",
	}),
	"chat.conversation_already_added": msg({
		id: "error.chat.conversation_already_added",
		message: "This conversation is already in the chat.",
	}),
	"chat.conversation_ids_empty": msg({
		id: "error.chat.conversation_ids_empty",
		message: "Select at least one conversation to add.",
	}),
	"chat.conversation_not_in_chat": msg({
		id: "error.chat.conversation_not_in_chat",
		message: "This conversation is no longer in the chat.",
	}),
	"chat.conversation_too_long": msg({
		id: "error.chat.conversation_too_long",
		message: "This conversation is too long to add to a chat.",
	}),
	"chat.mode_already_set": msg({
		id: "error.chat.mode_already_set",
		message:
			"This chat already has a mode. Start a new chat to use a different one.",
	}),
	"chat.not_found": msg({
		id: "error.chat.not_found",
		message: "We could not find this chat. It may have been deleted.",
	}),
	"chat.too_many_conversations": msg({
		id: "error.chat.too_many_conversations",
		message:
			"You can add up to {max} conversations at once. Select fewer and try again.",
	}),
	"chat.verify_unavailable": msg({
		id: "error.chat.verify_unavailable",
		message: "We could not check this chat just now. Try again in a moment.",
	}),
} satisfies Messages<"chat">;
