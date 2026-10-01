import type { Codes } from "./types";

/** Product announcements: staff write them, everyone reads and dismisses them. */
export const announcement = {
  "announcement.not_found": {
    action: "none",
    detail: "Announcement not found",
    description: "The announcement does not exist or was removed.",
  },
  "announcement.expiry_invalid": {
    action: "fix_input",
    detail: "expires_at is not a date",
    audience: "staff",
    description: "The announcement's expiry does not parse as a date.",
  },
  "announcement.expiry_past": {
    action: "fix_input",
    detail: "expires_at must be in the future",
    audience: "staff",
    description: "The announcement's expiry lies in the past.",
  },
  "announcement.language_invalid": {
    action: "fix_input",
    detail: "translations[{index}].languages_code must be one of {languages}",
    audience: "staff",
    description: "A translation names a language announcements are not written in.",
  },
  "announcement.title_length": {
    action: "fix_input",
    detail: "translations[{index}].title: 1 to 200 characters",
    audience: "staff",
    description: "A translation's title is empty or longer than 200 characters.",
  },
  "announcement.message_length": {
    action: "fix_input",
    detail: "translations[{index}].message: 1 to 10000 characters",
    audience: "staff",
    description: "A translation's message is empty or longer than 10000 characters.",
  },
  "announcement.duplicate_language": {
    action: "fix_input",
    detail: "One translation per language",
    audience: "staff",
    description: "Two translations share a language.",
  },
  "announcement.english_required": {
    action: "fix_input",
    detail: "An en-US translation is required",
    audience: "staff",
    description: "Every announcement needs an en-US translation to fall back on.",
  },
} as const satisfies Codes<"announcement">;
