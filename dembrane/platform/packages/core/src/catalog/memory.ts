import type { Codes } from "./types";

/** The assistant's memories: notes it keeps per user, project or organisation. */
export const memory = {
  "memory.not_found": {
    action: "none",
    detail: "Memory not found",
    description: "The memory does not exist, was deleted, or the caller cannot see it.",
  },
  "memory.invalid_scope": {
    action: "fix_input",
    detail: "Invalid scope. Use one of: {scopes}",
    description: "The memory scope is not one of the known scopes.",
  },
  "memory.content_required": {
    action: "fix_input",
    detail: "content is required",
    description: "A memory was created or updated without content.",
  },
} as const satisfies Codes<"memory">;
