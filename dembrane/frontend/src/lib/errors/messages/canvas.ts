import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const canvas = {
	"canvas.expiry_in_past": msg({
		id: "error.canvas.expiry_in_past",
		message: "Pick an end date in the future.",
	}),
	"canvas.expiry_too_far": msg({
		id: "error.canvas.expiry_too_far",
		message: "Pick an end date within the next 7 days.",
	}),
	"canvas.extraction_failed": msg({
		id: "error.canvas.extraction_failed",
		message:
			"We could not build the canvas preview just now. Try again in a moment.",
	}),
	"canvas.feature_off": msg({
		id: "error.canvas.feature_off",
		message: "Canvases are not switched on for this project.",
	}),
	"canvas.invalid_value": msg({
		id: "error.canvas.invalid_value",
		message:
			"Some of what you entered could not be used on the canvas. Check it and try again.",
	}),
	"canvas.just_previewed": msg({
		id: "error.canvas.just_previewed",
		message: "A preview was just made. Wait a moment before trying again.",
	}),
	"canvas.just_refreshed": msg({
		id: "error.canvas.just_refreshed",
		message:
			"This canvas was just refreshed. Wait a moment before refreshing it again.",
	}),
	"canvas.loop_ended": msg({
		id: "error.canvas.loop_ended",
		message:
			"This canvas has stopped refreshing. Create a new canvas to keep it up to date.",
	}),
	"canvas.loop_not_found": msg({
		id: "error.canvas.loop_not_found",
		message:
			"This canvas does not refresh on its own, so there is nothing to change here.",
	}),
	"canvas.not_found": msg({
		id: "error.canvas.not_found",
		message: "We could not find this canvas. It may have been deleted.",
	}),
} satisfies Messages<"canvas">;
