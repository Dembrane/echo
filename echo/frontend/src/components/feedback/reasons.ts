import { t } from "@lingui/core/macro";

export const REASON_KEYS = [
	"incorrect",
	"missed_question",
	"wrong_sources",
	"too_long_or_unclear",
	"wrong_language_or_tone",
	"other",
] as const;

export type ReasonKey = (typeof REASON_KEYS)[number];

export const reasonLabel = (key: ReasonKey): string => {
	switch (key) {
		case "incorrect":
			return t`Incorrect or made up`;
		case "missed_question":
			return t`Missed the question`;
		case "wrong_sources":
			return t`Wrong sources`;
		case "too_long_or_unclear":
			return t`Too long or unclear`;
		case "wrong_language_or_tone":
			return t`Wrong language or tone`;
		case "other":
			return t`Other`;
	}
};
