import { plural, t } from "@lingui/core/macro";
import type { Tool, ToolStatus } from "./store";

/** What a finished process says, per tool: in the toast, the phone's
 * pop-out and the rail item's name. */
export const finishedTitle = (tool: Tool, failed: boolean) => {
	switch (tool) {
		case "ask":
			return failed ? t`Ask could not answer` : t`Your answer is ready`;
		case "conversations":
			return failed ? t`Transcription failed` : t`Transcription done`;
		case "map":
			return failed ? t`Map failed` : t`Map ready`;
		case "present":
			return failed ? t`Presentation update failed` : t`Presentation updated`;
		case "report":
			return failed ? t`Report failed` : t`Report ready`;
	}
};

export const openLabel = (tool: Tool) => {
	switch (tool) {
		case "ask":
			return t`Open chat`;
		case "conversations":
			return t`Open conversations`;
		case "map":
			return t`Open map`;
		case "present":
			return t`Open presentation`;
		case "report":
			return t`Open report`;
	}
};

/** The running part of a rail item's name ("6 of 26 conversations"). */
export const runningSummary = (tool: Tool, status: ToolStatus) => {
	if (status.details.length) return status.details.join(" · ");
	if (tool === "ask")
		return plural(status.running, {
			one: "running a plan",
			other: "running # plans",
		});
	if (status.total) return t`${status.done ?? 0} of ${status.total}`;
	return t`working`;
};
