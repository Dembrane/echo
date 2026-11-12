import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const portal = {
	"portal.ai_unavailable": msg({
		id: "error.portal.ai_unavailable",
		message: "Not available right now.",
	}),
	"portal.try_failed": msg({
		id: "error.portal.try_failed",
		message: "The try did not work. Try again.",
	}),
} satisfies Messages<"portal">;
