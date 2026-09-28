import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const task = {
	"task.done_by_billing_details": msg({
		id: "error.task.done_by_billing_details",
		message: "You complete this task by saving your billing details.",
	}),
	"task.done_by_signing": msg({
		id: "error.task.done_by_signing",
		message: "You complete this task by signing the document.",
	}),
	"task.file_required": msg({
		id: "error.task.file_required",
		message: "This task needs a file. Add one and send again.",
	}),
	"task.not_found": msg({
		id: "error.task.not_found",
		message: "We could not find this task. It may have been withdrawn.",
	}),
	"task.not_open": msg({
		id: "error.task.not_open",
		message: "This task is not open yet. Finish the step before it first.",
	}),
	"task.not_waiting": msg({
		id: "error.task.not_waiting",
		message: "This task is not waiting for you right now.",
	}),
	"task.reply_required": msg({
		id: "error.task.reply_required",
		message: "Add a reply or a file before you send.",
	}),
} satisfies Messages<"task">;
