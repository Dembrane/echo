import type { Codes } from "./types";

/** Offer lines and totals, checked when staff or sam draft an offer. */
export const offer = {
  "offer.no_lines": {
    action: "fix_input",
    detail: "An offer needs at least one line",
    audience: "staff",
    description: "An offer was drafted without lines.",
  },
  "offer.line_quantity": {
    action: "fix_input",
    detail: "Line {line}: quantity must be a whole number of at least 1",
    audience: "staff",
    description: "A line's quantity is not a positive whole number. line counts from 1.",
  },
  "offer.line_unit_price": {
    action: "fix_input",
    detail: "Line {line}: unit price must be whole cents",
    audience: "staff",
    description: "A line's unit price is not a whole number of cents.",
  },
  "offer.line_vat_rate": {
    action: "fix_input",
    detail: "Line {line}: VAT rate must be one of {rates} basis points",
    audience: "staff",
    description: "A line's VAT rate is not one of the allowed rates.",
  },
  "offer.line_amount_too_large": {
    action: "fix_input",
    detail: "Line {line}: amount too large",
    audience: "staff",
    description: "A line's net amount does not fit a safe integer.",
  },
  "offer.negative_total": {
    action: "fix_input",
    detail: "An offer cannot total less than zero",
    audience: "staff",
    description: "The offer's lines add up to less than zero.",
  },
  "offer.line_no_amount": {
    action: "fix_input",
    detail: "Line {line}: give a price; an offer is not sent without amounts",
    audience: "staff",
    description: "A line's unit price is zero. line counts from 1.",
  },
  "offer.zero_total": {
    action: "fix_input",
    detail: "An offer must total more than zero",
    audience: "staff",
    description: "The offer's lines add up to zero, so there is nothing to ask the customer for.",
  },
  "offer.amendments_custom_only": {
    action: "fix_input",
    detail: "Only a custom offer can carry amendments",
    audience: "staff",
    description:
      "A subscription or event offer was given amendments; they change the standard documents, so the offer must be custom.",
  },
  "offer.template_not_found": {
    action: "none",
    detail: "No such offer template",
    audience: "staff",
    description:
      "The template is not subscription, event or custom, or the language is not en or nl.",
  },
} as const satisfies Codes<"offer">;
