import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const notification = {
	"notification.not_found": msg({
		id: "error.notification.not_found",
		message: "We could not find this notification. It may have been removed.",
	}),
} satisfies Messages<"notification">;
