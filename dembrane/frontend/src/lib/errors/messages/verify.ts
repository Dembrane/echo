import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const verify = {
	"verify.artifact_not_found": msg({
		id: "error.verify.artifact_not_found",
		message: "We could not find this. It may have been removed.",
	}),
	"verify.generation_failed": msg({
		id: "error.verify.generation_failed",
		message: "We could not write this just now. Try again.",
	}),
	"verify.no_chunks": msg({
		id: "error.verify.no_chunks",
		message:
			"Your recording has not reached us yet. Wait a moment and try again.",
	}),
	"verify.no_new_feedback": msg({
		id: "error.verify.no_new_feedback",
		message:
			"You have not added anything new yet. Say what you would change, then try again.",
	}),
	"verify.not_enabled": msg({
		id: "error.verify.not_enabled",
		message:
			"This step is switched off for this project. Ask the project admin to turn it on.",
	}),
	"verify.topic_not_found": msg({
		id: "error.verify.topic_not_found",
		message: "We could not find this topic. It may have been removed.",
	}),
	"verify.topic_unknown": msg({
		id: "error.verify.topic_unknown",
		message: "We could not find this topic. Go back and pick another one.",
	}),
} satisfies Messages<"verify">;
