import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const present = {
	"present.activity_not_in_presentation": msg({
		id: "error.present.activity_not_in_presentation",
		message:
			"This activity is not part of the presentation anymore. Reload the page.",
	}),
	"present.draft_conflict": msg({
		id: "error.present.draft_conflict",
		message:
			"This presentation was changed somewhere else. Reload to see the latest version, then make your change again.",
	}),
	"present.map_not_in_presentation": msg({
		id: "error.present.map_not_in_presentation",
		message: "This presentation does not show a map.",
	}),
	"present.map_results_not_ready": msg({
		id: "error.present.map_results_not_ready",
		message: "The map is not ready yet. It shows here as soon as it is.",
	}),
	"present.map_results_unavailable": msg({
		id: "error.present.map_results_unavailable",
		message: "The map for this presentation is not available.",
	}),
} satisfies Messages<"present">;
