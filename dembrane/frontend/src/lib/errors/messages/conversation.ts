import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const conversation = {
	"conversation.delete_failed": msg({
		id: "error.conversation.delete_failed",
		message: "We could not delete this conversation. Try again.",
	}),
	"conversation.locked": msg({
		id: "error.conversation.locked",
		message:
			"This conversation is locked on your current plan. Upgrade to open it.",
	}),
	"conversation.merge_failed": msg({
		id: "error.conversation.merge_failed",
		message:
			"We could not put the audio of this conversation together. Try again.",
	}),
	"conversation.move_context_mismatch": msg({
		id: "error.conversation.move_context_mismatch",
		message:
			"Conversations can only move to workspaces with the same billing and data owner. Pick a project in another workspace.",
	}),
	"conversation.move_sample": msg({
		id: "error.conversation.move_sample",
		message:
			"Conversations cannot move into or out of a sample project. Pick another project.",
	}),
	"conversation.no_content": msg({
		id: "error.conversation.no_content",
		message: "This conversation has no audio yet.",
	}),
	"conversation.no_summary": msg({
		id: "error.conversation.no_summary",
		message: "Make a summary of this conversation first, then try again.",
	}),
	"conversation.not_found": msg({
		id: "error.conversation.not_found",
		message: "We could not find this conversation. It may have been deleted.",
	}),
	"conversation.not_open": msg({
		id: "error.conversation.not_open",
		message:
			"This conversation is not open right now. Ask the organiser for a new link.",
	}),
} satisfies Messages<"conversation">;
