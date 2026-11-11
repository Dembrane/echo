import { ValidationError } from "@dembrane/core";
import { cleanVat, countryGroup, countryName, isCountryCode, vatFits } from "./billing-rules";
import type { VatTreatment } from "./money";

/**
 * Who is invoiced for an offer when it is not the customer: an agency between dembrane and
 * the end client, a sponsor or foundation that pays, a shared service centre, the customer's
 * other legal entity. One in eleven signed offers went to such a party, and a few went to
 * the wrong one first and were credited, so staff name it on the offer, the customer sees it
 * before signing, and the invoice request carries it in place of the customer's own billing
 * details. The customer's account, its billing details and its tasks stay as they are.
 */
export interface BillTo {
  /** The organisation the invoice is addressed to. */
  readonly name: string;
  /** Street and number. */
  readonly address: string;
  readonly postal_code: string | null;
  readonly city: string;
  /** ISO 3166-1 alpha-2. */
  readonly country_code: string;
  /** As stored: no spaces or dots, the EU prefix in front. Absent: they have none. */
  readonly vat_id: string | null;
  /** Where the invoice is sent. */
  readonly email: string;
  /** Their own reference for the invoice: a PO, a project code, a cost centre. */
  readonly reference: string | null;
}

/** What staff or sam typed, before it is checked. */
export interface BillToInput {
  readonly name: string;
  readonly address: string;
  readonly postal_code?: string | null | undefined;
  readonly city: string;
  readonly country_code: string;
  readonly vat_id?: string | null | undefined;
  readonly email: string;
  readonly reference?: string | null | undefined;
}

const given = (v: string | null | undefined) => (v ?? "").trim() || null;

/**
 * The party as the offer stores it, or a refusal staff can act on. The VAT choice is judged
 * on the party that pays, the way the invoice will be: the Netherlands takes Dutch VAT; a
 * business elsewhere in the EU with a VAT number takes reverse charge, which needs that
 * number; outside the EU there is no reverse charge. Dutch VAT for a party outside the EU
 * is left to whoever drafts the offer: what applies there is a question for the accountant.
 */
export function checkBillTo(input: BillToInput, treatment: VatTreatment): BillTo {
  const code = input.country_code.trim().toUpperCase();
  if (!isCountryCode(code)) throw new ValidationError("offer.bill_to_country");
  const vat = cleanVat(code, input.vat_id) || null;
  if (vat && !vatFits(code, vat))
    throw new ValidationError("offer.bill_to_vat_format", {
      params: { vat_id: vat, country: countryName(code) },
    });
  const party: BillTo = {
    name: input.name.trim(),
    address: input.address.trim(),
    postal_code: given(input.postal_code),
    city: input.city.trim(),
    country_code: code,
    vat_id: vat,
    email: input.email.trim(),
    reference: given(input.reference),
  };
  const problem = vatProblem(party, treatment);
  if (problem) throw new ValidationError(problem, { params: { name: party.name } });
  return party;
}

type VatProblem =
  | "offer.bill_to_dutch_vat"
  | "offer.bill_to_reverse_charge"
  | "offer.bill_to_vat_number"
  | "offer.bill_to_in_eu"
  | "offer.bill_to_outside_eu";

/** Why the offer's VAT choice does not fit the party it invoices; null when it does. */
export function vatProblem(
  p: Pick<BillTo, "country_code" | "vat_id">,
  treatment: VatTreatment,
): VatProblem | null {
  const group = countryGroup(p.country_code);
  const inEu = group !== null && group !== "other";
  if (group === "nl") return treatment === "standard" ? null : "offer.bill_to_dutch_vat";
  if (!inEu) return treatment === "reverse_charge" ? "offer.bill_to_outside_eu" : null;
  if (treatment === "outside_eu") return "offer.bill_to_in_eu";
  if (treatment === "reverse_charge") return p.vat_id ? null : "offer.bill_to_vat_number";
  // Dutch VAT to a business elsewhere in the EU: the invoice that was credited and reissued.
  return p.vat_id ? "offer.bill_to_reverse_charge" : null;
}

/**
 * The party in the shape of the invoice request's `billing`, so whoever drafts the invoice
 * reads one shape whoever pays. Delivery is by email; no KvK, KBO or Peppol is asked for.
 */
export function billToPayload(p: BillTo) {
  const group = countryGroup(p.country_code);
  return {
    legal_name: p.name,
    vat_id: p.vat_id,
    // Asked only in the EU, as on the billing form.
    no_vat_number: group === "other" ? null : !p.vat_id,
    kvk_number: null,
    kbo_number: null,
    billing_email: p.email,
    po_number: p.reference,
    peppol_id: null,
    invoice_delivery: "email" as const,
    invoice_portal: null,
    address: {
      line1: p.address,
      line2: null,
      postal_code: p.postal_code,
      city: p.city,
      country: countryName(p.country_code),
      country_code: p.country_code,
    },
  };
}

/** The party as the offer prints it, one line each, in the offer's language. */
export function billToLines(
  p: BillTo,
  language: "en" | "nl",
  words: { readonly vat: string; readonly reference: string },
): string[] {
  const place = [p.postal_code, p.city].filter(Boolean).join(" ");
  return [
    p.name,
    p.address,
    place,
    countryName(p.country_code, language),
    ...(p.vat_id ? [`${words.vat} ${p.vat_id}`] : []),
    p.email,
    ...(p.reference ? [`${words.reference}: ${p.reference}`] : []),
  ];
}
