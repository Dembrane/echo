import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const auth = {
	"auth.session_expired": msg({
		id: "error.auth.session_expired",
		message: "Your session has ended. Log in again to continue.",
	}),
	"auth.user_required": msg({
		id: "error.auth.user_required",
		message: "You need to be signed in for this. Sign in and try again.",
	}),
} satisfies Messages<"auth">;
