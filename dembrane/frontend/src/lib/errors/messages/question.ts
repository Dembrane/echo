import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const question = {
	"question.not_found": msg({
		id: "error.question.not_found",
		message: "We could not find this question. It may have been removed.",
	}),
} satisfies Messages<"question">;
