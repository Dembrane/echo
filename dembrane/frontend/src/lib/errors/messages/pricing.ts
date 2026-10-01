import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const pricing = {
	"pricing.configuration_not_owned": msg({
		id: "error.pricing.configuration_not_owned",
		message: "This configuration belongs to someone else. Start a new one.",
	}),
	"pricing.reference_unavailable": msg({
		id: "error.pricing.reference_unavailable",
		message: "We could not save your answers just now. Try again in a moment.",
	}),
} satisfies Messages<"pricing">;
