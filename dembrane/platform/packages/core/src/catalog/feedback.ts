import type { Codes } from "./types";

/** Issue reports from the dashboard and thumbs up or down on model output. */
export const feedback = {
  "feedback.message_required": {
    action: "fix_input",
    detail: "Message is required.",
    description: "An issue report came without text.",
  },
  "feedback.message_too_long": {
    action: "fix_input",
    detail: "Message is too long.",
    description: "An issue report's text is over the length limit.",
  },
  "feedback.too_many_attachments": {
    action: "fix_input",
    detail: "At most {max} attachments.",
    description: "An issue report carries more screenshots than allowed.",
  },
  "feedback.save_failed": {
    action: "retry",
    detail: "Could not save the report.",
    description:
      "The issue report's support request could not be written; stored images were removed. Sent as a 502.",
  },
  "feedback.attachment_path_invalid": {
    action: "none",
    detail: "Invalid path.",
    audience: "staff",
    description: "A staff attachment link named a path with a slash or a parent reference.",
  },
  "feedback.attachment_not_found": {
    action: "none",
    detail: "Not found.",
    audience: "staff",
    description: "The issue report attachment is not in storage.",
  },
  "feedback.message_not_found": {
    action: "none",
    detail: "Message not found",
    description: "The chat message being rated does not exist.",
  },
  "feedback.not_assistant_message": {
    action: "none",
    detail: "Only assistant messages can be rated",
    audience: "developer",
    description: "A rating named a message the person wrote.",
  },
  "feedback.target_unknown": {
    action: "fix_input",
    detail: "Unknown target type",
    audience: "developer",
    description: "A rating named a target type that is not implemented.",
  },
  "feedback.rating_invalid": {
    action: "fix_input",
    detail: "Rating must be up or down",
    audience: "developer",
    description: "A rating other than up or down.",
  },
  "feedback.reason_unknown": {
    action: "fix_input",
    detail: "Unknown reason: {reason}",
    audience: "developer",
    description: "A down rating named a reason outside the fixed list.",
  },
  "feedback.too_many_ids": {
    action: "fix_input",
    detail: "At most {max} ids per request",
    audience: "developer",
    description: "A ratings lookup named more targets than one request reads.",
  },
  "feedback.filter_invalid": {
    action: "fix_input",
    detail: "Unknown {filter}",
    audience: "staff",
    description:
      "The staff ratings list was filtered by an unknown rating, reason or chat mode; filter names which.",
  },
  "feedback.date_invalid": {
    action: "fix_input",
    detail: "{field} must be an ISO-8601 datetime",
    audience: "staff",
    description: "A staff ratings list date filter does not parse.",
  },
} as const satisfies Codes<"feedback">;
