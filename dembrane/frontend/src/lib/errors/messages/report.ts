import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const report = {
	"report.already_generating": msg({
		id: "error.report.already_generating",
		message:
			"A report for this project is already being made. Wait for it to finish, then try again.",
	}),
	"report.not_found": msg({
		id: "error.report.not_found",
		message: "We could not find this report. It may have been deleted.",
	}),
	"report.not_scheduled": msg({
		id: "error.report.not_scheduled",
		message:
			"This report is not scheduled, so there is nothing to publish early.",
	}),
	"report.schedule_invalid": msg({
		id: "error.report.schedule_invalid",
		message: "That date and time could not be read. Pick the time again.",
	}),
	"report.schedule_too_soon": msg({
		id: "error.report.schedule_too_soon",
		message: "Pick a time at least 10 minutes from now.",
	}),
} satisfies Messages<"report">;
