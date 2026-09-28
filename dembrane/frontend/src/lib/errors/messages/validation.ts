import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const validation = {
	"validation.invalid_input": msg({
		id: "error.validation.invalid_input",
		message:
			"Some fields need a fix. Check the highlighted fields and try again.",
	}),
} satisfies Messages<"validation">;
