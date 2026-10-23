import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const offer = {
	"offer.bill_to_country": msg({
		id: "error.offer.bill_to_country",
		message: "Choose the country of the organisation that is invoiced.",
	}),
	"offer.bill_to_dutch_vat": msg({
		id: "error.offer.bill_to_dutch_vat",
		message: "{name} is in the Netherlands. Choose Dutch VAT.",
	}),
	"offer.bill_to_in_eu": msg({
		id: "error.offer.bill_to_in_eu",
		message: "{name} is in the EU, so Outside the EU does not apply.",
	}),
	"offer.bill_to_outside_eu": msg({
		id: "error.offer.bill_to_outside_eu",
		message: "{name} is outside the EU, so reverse charge does not apply.",
	}),
	"offer.bill_to_reverse_charge": msg({
		id: "error.offer.bill_to_reverse_charge",
		message: "{name} is a business elsewhere in the EU. Choose reverse charge.",
	}),
	"offer.bill_to_vat_format": msg({
		id: "error.offer.bill_to_vat_format",
		message: "{vat_id} does not look like a VAT number from {country}.",
	}),
	"offer.bill_to_vat_number": msg({
		id: "error.offer.bill_to_vat_number",
		message: "Reverse charge needs the VAT number of {name}.",
	}),
	"offer.invoice_part_share": msg({
		id: "error.offer.invoice_part_share",
		message: "Give part {part} a share above zero.",
	}),
	"offer.invoice_part_when": msg({
		id: "error.offer.invoice_part_when",
		message:
			"Part {part}: only the first part can be on signing, and each date comes after the one before.",
	}),
	"offer.invoice_parts_count": msg({
		id: "error.offer.invoice_parts_count",
		message: "Invoice in {min} to {max} parts.",
	}),
	"offer.invoice_parts_vat": msg({
		id: "error.offer.invoice_parts_vat",
		message: "To invoice in parts, give every charged line the same VAT rate.",
	}),
	"offer.invoice_shares_total": msg({
		id: "error.offer.invoice_shares_total",
		message: "The parts add up to {total}. Make them add up to 100%.",
	}),
} satisfies Messages<"offer">;
