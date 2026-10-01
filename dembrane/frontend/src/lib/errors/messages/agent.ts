import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const agent = {
	"agent.insight_content_blank": msg({
		id: "error.agent.insight_content_blank",
		message: "The insight cannot be empty. Write something or remove it.",
	}),
	"agent.insight_content_required": msg({
		id: "error.agent.insight_content_required",
		message: "Write something for the insight.",
	}),
	"agent.insight_not_found": msg({
		id: "error.agent.insight_not_found",
		message: "We could not find this insight. It may have been removed.",
	}),
	"agent.insight_reason_required": msg({
		id: "error.agent.insight_reason_required",
		message: "Add a short reason before you dismiss this insight.",
	}),
	"agent.insight_update_empty": msg({
		id: "error.agent.insight_update_empty",
		message: "There are no changes to save.",
	}),
	"agent.no_active_turn": msg({
		id: "error.agent.no_active_turn",
		message: "There is no answer in progress to stop.",
	}),
	"agent.run_forbidden": msg({
		id: "error.agent.run_forbidden",
		message: "You do not have access to this chat.",
	}),
	"agent.run_not_found": msg({
		id: "error.agent.run_not_found",
		message: "We could not find this chat run. Reload the page and try again.",
	}),
} satisfies Messages<"agent">;
