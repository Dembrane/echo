import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const access = {
	"access.forbidden": msg({
		id: "error.access.forbidden",
		message: "You do not have permission to do this.",
	}),
	"access.not_onboarded": msg({
		id: "error.access.not_onboarded",
		message: "Finish setting up your account to continue.",
	}),
} satisfies Messages<"access">;
