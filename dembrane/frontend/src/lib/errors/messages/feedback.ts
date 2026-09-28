import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const feedback = {
	"feedback.message_not_found": msg({
		id: "error.feedback.message_not_found",
		message: "We could not find this message. It may have been deleted.",
	}),
	"feedback.message_required": msg({
		id: "error.feedback.message_required",
		message: "Write a short message about the problem.",
	}),
	"feedback.message_too_long": msg({
		id: "error.feedback.message_too_long",
		message: "Your message is too long. Make it shorter and send it again.",
	}),
	"feedback.save_failed": msg({
		id: "error.feedback.save_failed",
		message: "We could not send your report. Try again.",
	}),
	"feedback.too_many_attachments": msg({
		id: "error.feedback.too_many_attachments",
		message: "You can add at most {max} screenshots.",
	}),
} satisfies Messages<"feedback">;
