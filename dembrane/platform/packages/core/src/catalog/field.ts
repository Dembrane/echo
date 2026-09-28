import type { Codes } from "./types";

/**
 * Field-level codes: a validation error lists one per failing field, with the field's path,
 * so a form can show the problem next to the input. The details here are the English the
 * frontend never shows; each issue carries pydantic's own `msg` for parity.
 */
export const field = {
  "field.required": {
    action: "fix_input",
    detail: "Field required",
    description: "A required field is missing from the request.",
  },
  "field.invalid_type": {
    action: "fix_input",
    detail: "Input should be a valid {expected}",
    description: "The field holds the wrong kind of value (text for a number, and so on).",
  },
  "field.too_short": {
    action: "fix_input",
    detail: "Should have at least {min_length} characters",
    description: "Text shorter than the field allows.",
  },
  "field.too_long": {
    action: "fix_input",
    detail: "Should have at most {max_length} characters",
    description: "Text longer than the field allows.",
  },
  "field.too_few_items": {
    action: "fix_input",
    detail: "Should have at least {min_length} items",
    description: "A list with fewer items than the field needs.",
  },
  "field.too_small": {
    action: "fix_input",
    detail: "Should be at least {min}",
    description: "A number below the field's lower bound.",
  },
  "field.too_large": {
    action: "fix_input",
    detail: "Should be at most {max}",
    description: "A number above the field's upper bound.",
  },
  "field.invalid_choice": {
    action: "fix_input",
    detail: "Should be {expected}",
    description: "A value outside the field's fixed set of choices.",
  },
  "field.invalid_email": {
    action: "fix_input",
    detail: "Not a valid email address",
    description: "An email address that fails the syntax check.",
  },
  "field.invalid_url": {
    action: "fix_input",
    detail: "Not a valid web address",
    description: "A link that is not an http or https address.",
  },
  "field.invalid_date": {
    action: "fix_input",
    detail: "Not a valid date",
    description: "A date or datetime that does not parse.",
  },
  "field.invalid_json": {
    action: "fix_input",
    detail: "JSON decode error",
    description: "The request body is not valid JSON.",
  },
  "field.invalid": {
    action: "fix_input",
    detail: "Invalid value",
    description: "The field failed a check specific to it; the issue's msg says which.",
  },
} as const satisfies Codes<"field">;
