import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const field = {
	"field.invalid": msg({
		id: "error.field.invalid",
		message: "Check this field and try again.",
	}),
	"field.invalid_choice": msg({
		id: "error.field.invalid_choice",
		message: "Pick one of the options.",
	}),
	"field.invalid_date": msg({
		id: "error.field.invalid_date",
		message: "Enter a valid date.",
	}),
	"field.invalid_email": msg({
		id: "error.field.invalid_email",
		message: "Enter a valid email address.",
	}),
	"field.invalid_json": msg({
		id: "error.field.invalid_json",
		message:
			"Something in this form could not be read. Reload the page and try again.",
	}),
	"field.invalid_type": msg({
		id: "error.field.invalid_type",
		message: "This value is not the right kind. Check it and try again.",
	}),
	"field.invalid_url": msg({
		id: "error.field.invalid_url",
		message: "Enter a web address that starts with http:// or https://.",
	}),
	"field.required": msg({
		id: "error.field.required",
		message: "Fill in this field.",
	}),
	"field.too_few_items": msg({
		id: "error.field.too_few_items",
		message: "Add at least {min_length}.",
	}),
	"field.too_large": msg({
		id: "error.field.too_large",
		message: "Use a number of at most {max}.",
	}),
	"field.too_long": msg({
		id: "error.field.too_long",
		message: "Use at most {max_length} characters.",
	}),
	"field.too_short": msg({
		id: "error.field.too_short",
		message: "Use at least {min_length} characters.",
	}),
	"field.too_small": msg({
		id: "error.field.too_small",
		message: "Use a number of at least {min}.",
	}),
} satisfies Messages<"field">;
