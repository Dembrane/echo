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
    detail: "Line {line}: the quantity must be above 0, with at most two decimals",
    audience: "staff",
    description:
      "A line's quantity is zero, negative or has more than two decimals (1.5 and 0.25 are fine). line counts from 1.",
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
    detail: "An offer must total more than zero; for a free offer, choose No charge",
    audience: "staff",
    description:
      "The offer's charged lines add up to zero (optional and included lines do not count), so there is nothing to ask the customer for. An offer meant to be free is drafted with no_charge.",
  },
  "offer.no_charge_total": {
    action: "fix_input",
    detail: "A no-charge offer totals zero: set the prices to 0 or turn off No charge",
    audience: "staff",
    description:
      "An offer drafted with no_charge has charged lines that add up to more or less than zero.",
  },
  "offer.no_charge_invoiced": {
    action: "fix_input",
    detail: "A no-charge offer is never invoiced, so it takes no invoice plan or paying party",
    audience: "staff",
    description: "An offer drafted with no_charge also carries an invoice_plan or bill_to.",
  },
  "offer.option_not_optional": {
    action: "fix_input",
    detail: "Line {line} has an option name: make it optional, or clear the name",
    audience: "staff",
    description:
      "A line that is charged or included carries an option name; only an optional line can be chosen at signing. line counts from 1.",
  },
  "offer.options_not_here": {
    action: "fix_input",
    detail: "Options chosen at signing do not go with an invoice plan or No charge",
    audience: "staff",
    description: "An offer with options also carries an invoice_plan or no_charge.",
  },
  "offer.choose_one_needs_two": {
    action: "fix_input",
    detail: "To have one picked, give at least two options",
    audience: "staff",
    description: "An offer with choose one has fewer than two options.",
  },
  "offer.second_signer_staff": {
    action: "fix_input",
    detail: "dembrane's signatory must be a staff member: give their @dembrane.com address",
    audience: "staff",
    description: "The counter-signature names an email outside dembrane.",
  },
  "offer.section_missing": {
    action: "fix_input",
    detail: "Line {line} has no section: put every line under a heading, or none",
    audience: "staff",
    description: "Some lines carry a section and others do not. line counts from 1.",
  },
  "offer.section_split": {
    action: "fix_input",
    detail: "The lines of section {section} must sit together",
    audience: "staff",
    description:
      "A section's lines are interrupted by another section's; each heading is written once, over all its lines.",
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
  "offer.invoice_parts_vat": {
    action: "fix_input",
    detail: "An offer invoiced in parts needs one VAT rate on its charged lines",
    audience: "staff",
    description:
      "An invoice plan was given to an offer whose charged lines carry different VAT rates; parts are cut from one total at one rate.",
  },
  "offer.invoice_parts_count": {
    action: "fix_input",
    detail: "Invoice in {min} to {max} parts",
    audience: "staff",
    description:
      "An invoice plan has too few or too many parts: 2 to 24 monthly parts, 2 to 12 instalments.",
  },
  "offer.invoice_part_when": {
    action: "fix_input",
    detail: "Part {part}: only the first part falls on signing, and the dates follow each other",
    audience: "staff",
    description:
      "An instalment is neither on signing (first part only) nor a valid ISO date on or after the part before it. part counts from 1.",
  },
  "offer.invoice_part_share": {
    action: "fix_input",
    detail: "Part {part} needs a share above zero",
    audience: "staff",
    description: "An instalment's share is not a whole number of basis points above zero.",
  },
  "offer.invoice_shares_total": {
    action: "fix_input",
    detail: "The parts add up to {total}; they must add up to 100%",
    audience: "staff",
    description: "The instalments' shares do not add up to 10000 basis points.",
  },
  "offer.template_not_found": {
    action: "none",
    detail: "No such offer template",
    audience: "staff",
    description:
      "The template is not subscription, event or custom, or the language is not en or nl.",
  },
} as const satisfies Codes<"offer">;
