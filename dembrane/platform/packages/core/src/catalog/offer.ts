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
  "offer.included_has_price": {
    action: "fix_input",
    detail: "Line {line} is included at no charge: leave its price at 0",
    audience: "staff",
    description:
      "A line marked included carries a unit price; an included line is shown without one and never counts. line counts from 1.",
  },
  "offer.zero_total": {
    action: "fix_input",
    detail: "An offer must total more than zero",
    audience: "staff",
    description:
      "The offer's charged lines add up to zero (optional and included lines do not count), so there is nothing to ask the customer for.",
  },
  "offer.amendments_custom_only": {
    action: "fix_input",
    detail: "Only a custom offer can carry amendments",
    audience: "staff",
    description:
      "A subscription or event offer was given amendments; they change the standard documents, so the offer must be custom.",
  },
  "offer.bill_to_country": {
    action: "fix_input",
    detail: "Choose the country of the organisation that is invoiced",
    audience: "staff",
    description: "The party invoiced in place of the customer has no known ISO country code.",
  },
  "offer.bill_to_vat_format": {
    action: "fix_input",
    detail: "{vat_id} does not look like a VAT number from {country}",
    audience: "staff",
    description:
      "The VAT number of the party invoiced in place of the customer does not fit its country's format.",
  },
  "offer.bill_to_dutch_vat": {
    action: "fix_input",
    detail: "{name} is in the Netherlands: choose Dutch VAT",
    audience: "staff",
    description:
      "The offer is invoiced to a party in the Netherlands but carries reverse charge or outside the EU.",
  },
  "offer.bill_to_reverse_charge": {
    action: "fix_input",
    detail: "{name} is a business elsewhere in the EU: choose reverse charge",
    audience: "staff",
    description:
      "The offer is invoiced to a party in another EU country with a VAT number but carries Dutch VAT.",
  },
  "offer.bill_to_vat_number": {
    action: "fix_input",
    detail: "Reverse charge needs the VAT number of {name}",
    audience: "staff",
    description:
      "The offer is reverse-charged to a party in another EU country that has no VAT number on it.",
  },
  "offer.bill_to_in_eu": {
    action: "fix_input",
    detail: "{name} is in the EU: outside the EU does not apply",
    audience: "staff",
    description:
      "The offer is invoiced to a party in an EU country but carries the outside-the-EU treatment.",
  },
  "offer.bill_to_outside_eu": {
    action: "fix_input",
    detail: "{name} is outside the EU: reverse charge does not apply",
    audience: "staff",
    description: "The offer is reverse-charged to a party outside the EU.",
  },
  "offer.template_not_found": {
    action: "none",
    detail: "No such offer template",
    audience: "staff",
    description:
      "The template is not subscription, event or custom, or the language is not en or nl.",
  },
} as const satisfies Codes<"offer">;
