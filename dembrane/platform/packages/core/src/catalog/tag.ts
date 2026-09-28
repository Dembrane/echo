import type { Codes } from "./types";

export const tag = {
  "tag.not_found": {
    action: "none",
    detail: "Tag not found",
    description: "The tag does not exist or belongs to another project.",
  },
} as const satisfies Codes<"tag">;
