import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const analysis = {
	"analysis.feature_disabled": msg({
		id: "error.analysis.feature_disabled",
		message: "Editing results is not available here.",
	}),
	"analysis.field_not_editable": msg({
		id: "error.analysis.field_not_editable",
		message: "This part of the result cannot be edited here.",
	}),
	"analysis.invalid_request": msg({
		id: "error.analysis.invalid_request",
		message:
			"Some of what you entered could not be used. Check it and try again.",
	}),
	"analysis.object_not_found": msg({
		id: "error.analysis.object_not_found",
		message:
			"We could not find this result. It may have been removed when the analysis ran again.",
	}),
	"analysis.read_only_type": msg({
		id: "error.analysis.read_only_type",
		message: "This kind of result cannot be edited.",
	}),
	"analysis.revision_conflict": msg({
		id: "error.analysis.revision_conflict",
		message:
			"Someone changed this result while you were looking at it. Reload to see their version, then make your change again.",
	}),
	"analysis.revision_not_found": msg({
		id: "error.analysis.revision_not_found",
		message:
			"This version of the result no longer exists. Reload the page to see the latest one.",
	}),
	"analysis.run_not_found": msg({
		id: "error.analysis.run_not_found",
		message: "We could not find this analysis run.",
	}),
	"analysis.snapshot_not_found": msg({
		id: "error.analysis.snapshot_not_found",
		message:
			"We could not find these analysis results. Reload the page to see the latest ones.",
	}),
	"analysis.storage_unavailable": msg({
		id: "error.analysis.storage_unavailable",
		message: "We could not load the analysis just now. Try again in a moment.",
	}),
} satisfies Messages<"analysis">;
