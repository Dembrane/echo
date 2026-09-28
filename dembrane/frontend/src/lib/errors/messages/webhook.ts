import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const webhook = {
	"webhook.invalid_event": msg({
		id: "error.webhook.invalid_event",
		message:
			"One of the chosen events is not available. Pick the events again.",
	}),
	"webhook.invalid_status": msg({
		id: "error.webhook.invalid_status",
		message: "Pick a status for this webhook: published, draft or archived.",
	}),
	"webhook.invalid_url": msg({
		id: "error.webhook.invalid_url",
		message: "Enter a web address that starts with http:// or https://.",
	}),
	"webhook.not_found": msg({
		id: "error.webhook.not_found",
		message: "We could not find this webhook. It may have been deleted.",
	}),
	"webhook.target_not_allowed": msg({
		id: "error.webhook.target_not_allowed",
		message:
			"We cannot send webhooks to this address. Use a public web address.",
	}),
} satisfies Messages<"webhook">;
