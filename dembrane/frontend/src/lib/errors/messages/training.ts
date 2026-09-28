import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const training = {
	"training.completed_at_invalid": msg({
		id: "error.training.completed_at_invalid",
		message: "That completion date could not be read. Enter it again.",
	}),
	"training.license_not_found": msg({
		id: "error.training.license_not_found",
		message: "We could not find this license.",
	}),
	"training.no_license": msg({
		id: "error.training.no_license",
		message: "This training does not come with a license.",
	}),
	"training.not_available": msg({
		id: "error.training.not_available",
		message: "This training is not open for booking yet.",
	}),
	"training.not_found": msg({
		id: "error.training.not_found",
		message: "We could not find this training.",
	}),
	"training.unknown_type": msg({
		id: "error.training.unknown_type",
		message:
			"We do not know this type of training. Reload the page and pick one again.",
	}),
} satisfies Messages<"training">;
