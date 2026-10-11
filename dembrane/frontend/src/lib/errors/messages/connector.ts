import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const connector = {
	"connector.board_not_found": msg({
		id: "error.connector.board_not_found",
		message:
			"We could not open that board. Check the link, and that your Miro account can see it.",
	}),
	"connector.invalid_voice": msg({
		id: "error.connector.invalid_voice",
		message: "Choose whose words these are: participants, organisers or mixed.",
	}),
	"connector.no_frames": msg({
		id: "error.connector.no_frames",
		message: "Pick at least one frame from the board.",
	}),
	"connector.not_configured": msg({
		id: "error.connector.not_configured",
		message: "{provider} is not set up on this dembrane server yet.",
	}),
	"connector.not_connected": msg({
		id: "error.connector.not_connected",
		message: "Connect {provider} first, then try again.",
	}),
	"connector.provider_refused": msg({
		id: "error.connector.provider_refused",
		message: "{provider} did not answer as expected. Try again in a moment.",
	}),
	"connector.sign_in_expired": msg({
		id: "error.connector.sign_in_expired",
		message: "The sign-in with {provider} expired. Start it again.",
	}),
	"connector.source_not_found": msg({
		id: "error.connector.source_not_found",
		message: "We could not find this source. It may have been removed.",
	}),
} satisfies Messages<"connector">;
