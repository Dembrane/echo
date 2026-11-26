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
	"access.support_session_limited": msg({
		id: "error.access.support_session_limited",
		message:
			"You're here for support, so this is left to the workspace's admins.",
	}),
} satisfies Messages<"access">;
