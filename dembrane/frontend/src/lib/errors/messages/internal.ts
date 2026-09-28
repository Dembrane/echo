import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const internal = {
	"internal.busy": msg({
		id: "error.internal.busy",
		message: "dembrane is busy with this right now. Try again in a second.",
	}),
	"internal.unavailable": msg({
		id: "error.internal.unavailable",
		message:
			"We could not reach part of dembrane just now. Try again in a moment.",
	}),
	"internal.unexpected": msg({
		id: "error.internal.unexpected",
		message: "Something went wrong on our side. Try again in a moment.",
	}),
} satisfies Messages<"internal">;
