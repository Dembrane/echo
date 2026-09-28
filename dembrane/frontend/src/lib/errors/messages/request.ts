import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const request = {
	"request.field_empty": msg({
		id: "error.request.field_empty",
		message: "{field} cannot be empty. Fill it in or remove it.",
	}),
	"request.field_required": msg({
		id: "error.request.field_required",
		message: "Fill in {field}.",
	}),
	"request.invalid": msg({
		id: "error.request.invalid",
		message:
			"Something in this request was not right. Reload the page and try again.",
	}),
	"request.invalid_json": msg({
		id: "error.request.invalid_json",
		message:
			"Something in this request was not right. Reload the page and try again.",
	}),
	"request.nothing_to_update": msg({
		id: "error.request.nothing_to_update",
		message: "There are no changes to save.",
	}),
	"request.too_large": msg({
		id: "error.request.too_large",
		message: "This is too large to send. Try something smaller.",
	}),
} satisfies Messages<"request">;
