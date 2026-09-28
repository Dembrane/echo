import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const rate_limit = {
	"rate_limit.exceeded": msg({
		id: "error.rate_limit.exceeded",
		message:
			"That was a lot of requests in a short time. Wait a moment and try again.",
	}),
	"rate_limit.too_many_streams": msg({
		id: "error.rate_limit.too_many_streams",
		message:
			"You have too many live views open. Close a few tabs and try again in a moment.",
	}),
} satisfies Messages<"rate_limit">;
