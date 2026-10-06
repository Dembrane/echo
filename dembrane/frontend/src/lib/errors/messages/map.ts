import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const map = {
	"map.fact_check_not_started": msg({
		id: "error.map.fact_check_not_started",
		message: "We could not start the fact-check. Try again in a moment.",
	}),
	"map.generation_not_started": msg({
		id: "error.map.generation_not_started",
		message: "We could not start making the map. Try again in a moment.",
	}),
	"map.group_not_started": msg({
		id: "error.map.group_not_started",
		message: "We could not keep this cluster. Try again in a moment.",
	}),
	"map.groups_need_snapshot": msg({
		id: "error.map.groups_need_snapshot",
		message:
			"Clusters can be kept on a regenerated map. Regenerate the map and try again.",
	}),
	"map.no_map_yet": msg({
		id: "error.map.no_map_yet",
		message: "This project has no map yet. Create one to see it here.",
	}),
	"map.not_a_claim": msg({
		id: "error.map.not_a_claim",
		message: "Only claims can be fact-checked. Pick a claim and try again.",
	}),
	"map.not_found": msg({
		id: "error.map.not_found",
		message: "We could not find this map.",
	}),
	"map.not_ready": msg({
		id: "error.map.not_ready",
		message: "The map is still being made. Wait a moment and try again.",
	}),
	"map.selection_not_in_map": msg({
		id: "error.map.selection_not_in_map",
		message:
			"Part of your selection is no longer on the map. Reload the map and select again.",
	}),
	"map.selection_other_snapshot": msg({
		id: "error.map.selection_other_snapshot",
		message:
			"The map was updated since you made this selection. Reload the map and select again.",
	}),
	"map.selection_too_large": msg({
		id: "error.map.selection_too_large",
		message: "You selected too many items. Select fewer and try again.",
	}),
	"map.selection_too_small": msg({
		id: "error.map.selection_too_small",
		message: "Select a few more items to create a title.",
	}),
	"map.storage_unavailable": msg({
		id: "error.map.storage_unavailable",
		message: "We could not load the map just now. Try again in a moment.",
	}),
	"map.title_failed": msg({
		id: "error.map.title_failed",
		message: "We could not create a title just now. Try again.",
	}),
} satisfies Messages<"map">;
