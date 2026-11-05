import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const portal = {
	"portal.ai_unavailable": msg({
		id: "error.portal.ai_unavailable",
		message: "Not available right now.",
	}),
} satisfies Messages<"portal">;
