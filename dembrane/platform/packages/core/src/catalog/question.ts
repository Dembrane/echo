import type { Codes } from "./types";

/** Questions a customer asks from their account page, answered by staff. */
export const question = {
  "question.not_found": {
    action: "none",
    detail: "Question not found",
    description: "The question does not exist or belongs to another organisation.",
  },
} as const satisfies Codes<"question">;
