import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const account = {
	"account.credentials_invalid": msg({
		id: "error.account.credentials_invalid",
		message: "That password is not right. Check it and try again.",
	}),
	"account.email_missing": msg({
		id: "error.account.email_missing",
		message:
			"Your account has no email address yet. Contact support to add one.",
	}),
	"account.image_too_large": msg({
		id: "error.account.image_too_large",
		message: "This image is too large. Images can be at most {max_mb} MB.",
	}),
	"account.image_type": msg({
		id: "error.account.image_type",
		message: "Upload a PNG, JPEG, WebP or GIF image.",
	}),
	"account.otp_invalid": msg({
		id: "error.account.otp_invalid",
		message:
			"That code did not work. Enter the current code from your authenticator app.",
	}),
	"account.password_incorrect": msg({
		id: "error.account.password_incorrect",
		message: "Your current password is not right. Check it and try again.",
	}),
	"account.password_weak": msg({
		id: "error.account.password_weak",
		message:
			"This password is not strong enough. Try a longer one with a mix of letters, numbers and symbols.",
	}),
	"account.tfa_already_enabled": msg({
		id: "error.account.tfa_already_enabled",
		message: "Two-factor authentication is already on for your account.",
	}),
	"account.tfa_not_enabled": msg({
		id: "error.account.tfa_not_enabled",
		message:
			"Two-factor authentication is not on for your account, so there is nothing to switch off.",
	}),
	"account.user_not_found": msg({
		id: "error.account.user_not_found",
		message:
			"We could not load your account. Contact support and we will sort it out.",
	}),
} satisfies Messages<"account">;
