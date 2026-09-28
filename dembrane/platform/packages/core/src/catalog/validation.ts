import type { Codes } from "./types";

export const validation = {
  "validation.invalid_input": {
    action: "fix_input",
    detail: "Request validation failed",
    params: ["fields"],
    description:
      "The request failed validation. params.fields lists each failing field as { field, loc, code, params }, with field codes from the field namespace.",
  },
} as const satisfies Codes<"validation">;
