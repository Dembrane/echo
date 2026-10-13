import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const popcorn = {
	"popcorn.branding_tier": msg({
		id: "error.popcorn.branding_tier",
		message:
			"Removing the dembrane mark is part of the Changemaker plan. Upgrade to use it.",
	}),
	"popcorn.creation_busy": msg({
		id: "error.popcorn.creation_busy",
		message:
			"A presentation is already being created for this project. Try again in a moment.",
	}),
	"popcorn.feature_disabled": msg({
		id: "error.popcorn.feature_disabled",
		message: "This feature is not available for this project.",
	}),
	"popcorn.invalid_live_hours": msg({
		id: "error.popcorn.invalid_live_hours",
		message: "Pick one of the offered durations: {hours} hours.",
	}),
	"popcorn.invalid_ready_by": msg({
		id: "error.popcorn.invalid_ready_by",
		message: "Pick a time later than now and within the next 7 days.",
	}),
	"popcorn.just_refreshed": msg({
		id: "error.popcorn.just_refreshed",
		message: "This was just updated. Wait a few seconds before you try again.",
	}),
	"popcorn.loop_not_found": msg({
		id: "error.popcorn.loop_not_found",
		message: "This presentation is not running. Start it again to continue.",
	}),
	"popcorn.not_found": msg({
		id: "error.popcorn.not_found",
		message: "We could not find this presentation.",
	}),
	"popcorn.public_not_found": msg({
		id: "error.popcorn.public_not_found",
		message:
			"This presentation link does not work anymore. Ask the host for a new link.",
	}),
	"popcorn.settings_busy": msg({
		id: "error.popcorn.settings_busy",
		message:
			"Someone else is saving these settings right now. Try again in a moment.",
	}),
	"popcorn.synthetic_frame_locked": msg({
		id: "error.popcorn.synthetic_frame_locked",
		message:
			"The frame of a demo presentation is set with the demo and cannot be changed here.",
	}),
	"popcorn.version_not_found": msg({
		id: "error.popcorn.version_not_found",
		message: "We could not find this version of the presentation.",
	}),
} satisfies Messages<"popcorn">;
