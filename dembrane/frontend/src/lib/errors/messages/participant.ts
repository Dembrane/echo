import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const participant = {
	"participant.report_not_found": msg({
		id: "error.participant.report_not_found",
		message: "This report is not available. It may not be published yet.",
	}),
	"participant.subscribe_failed": msg({
		id: "error.participant.subscribe_failed",
		message: "We could not sign up every email address. Try again.",
	}),
	"participant.token_invalid": msg({
		id: "error.participant.token_invalid",
		message:
			"This link does not match this conversation. Open the link you were given again.",
	}),
	"participant.token_required": msg({
		id: "error.participant.token_required",
		message: "We lost track of your conversation. Reload the page to continue.",
	}),
	"participant.unsubscribe_link_invalid": msg({
		id: "error.participant.unsubscribe_link_invalid",
		message:
			"This unsubscribe link is not complete. Open the link from your email again.",
	}),
	"participant.unsubscribe_link_unknown": msg({
		id: "error.participant.unsubscribe_link_unknown",
		message:
			"We could not find this subscription. You may already be unsubscribed.",
	}),
} satisfies Messages<"participant">;
