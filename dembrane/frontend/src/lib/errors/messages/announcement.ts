import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const announcement = {
	"announcement.not_found": msg({
		id: "error.announcement.not_found",
		message: "This announcement is no longer available.",
	}),
} satisfies Messages<"announcement">;
