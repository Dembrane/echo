/**
 * What the billing form asks, by country, and how each number must look. One set of rules
 * for the form and the API: scripts/sync-accounts-contract.mjs copies this file into the
 * frontend, so a number the form accepts is a number the API accepts.
 *
 * The country comes first because it decides the rest: the Netherlands asks for a KvK or
 * VAT number, Belgium and the other EU countries for a VAT number or the plain statement
 * that there is none (Belgium then gives its KBO number), and a country outside the EU
 * for nothing more. Formats only: no number is looked up anywhere, and nothing here says
 * what tax applies. That is decided by whoever sends the invoice.
 */

/** ISO 3166-1 alpha-2, every officially assigned code. */
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM " +
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const KNOWN = new Set(COUNTRY_CODES);
export const isCountryCode = (v: unknown): v is string => typeof v === "string" && KNOWN.has(v);

/**
 * How a VAT number looks in each EU member state, after spaces, dots and dashes are taken
 * out: the prefix (Greece writes EL, not GR), what follows it, and one made-up example to
 * show beside the field. Source: the European Commission's VIES table of formats; the
 * Dutch row follows the Belastingdienst (nine digits, B, two digits).
 */
export const EU_VAT: Readonly<Record<string, { prefix: string; body: RegExp; example: string }>> = {
  AT: { prefix: "AT", body: /^U\d{8}$/, example: "ATU12345678" },
  BE: { prefix: "BE", body: /^[01]\d{9}$/, example: "BE0123456789" },
  BG: { prefix: "BG", body: /^\d{9,10}$/, example: "BG123456789" },
  CY: { prefix: "CY", body: /^\d{8}[A-Z]$/, example: "CY12345678X" },
  CZ: { prefix: "CZ", body: /^\d{8,10}$/, example: "CZ12345678" },
  DE: { prefix: "DE", body: /^\d{9}$/, example: "DE123456789" },
  DK: { prefix: "DK", body: /^\d{8}$/, example: "DK12345678" },
  EE: { prefix: "EE", body: /^\d{9}$/, example: "EE123456789" },
  ES: { prefix: "ES", body: /^(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])$/, example: "ESX1234567X" },
  FI: { prefix: "FI", body: /^\d{8}$/, example: "FI12345678" },
  FR: { prefix: "FR", body: /^[A-HJ-NP-Z0-9]{2}\d{9}$/, example: "FR12345678901" },
  GR: { prefix: "EL", body: /^\d{9}$/, example: "EL123456789" },
  HR: { prefix: "HR", body: /^\d{11}$/, example: "HR12345678901" },
  HU: { prefix: "HU", body: /^\d{8}$/, example: "HU12345678" },
  IE: {
    prefix: "IE",
    body: /^(?:\d[A-Z0-9+*]\d{5}[A-Z]|\d{7}[A-Z]{2})$/,
    example: "IE1234567WA",
  },
  IT: { prefix: "IT", body: /^\d{11}$/, example: "IT12345678901" },
  LT: { prefix: "LT", body: /^(?:\d{9}|\d{12})$/, example: "LT123456789" },
  LU: { prefix: "LU", body: /^\d{8}$/, example: "LU12345678" },
  LV: { prefix: "LV", body: /^\d{11}$/, example: "LV12345678901" },
  MT: { prefix: "MT", body: /^\d{8}$/, example: "MT12345678" },
  NL: { prefix: "NL", body: /^\d{9}B\d{2}$/, example: "NL123456789B01" },
  PL: { prefix: "PL", body: /^\d{10}$/, example: "PL1234567890" },
  PT: { prefix: "PT", body: /^\d{9}$/, example: "PT123456789" },
  RO: { prefix: "RO", body: /^\d{2,10}$/, example: "RO12345678" },
  SE: { prefix: "SE", body: /^\d{12}$/, example: "SE123456789001" },
  SI: { prefix: "SI", body: /^\d{8}$/, example: "SI12345678" },
  SK: { prefix: "SK", body: /^\d{10}$/, example: "SK1234567890" },
};

/** Which set of numbers the form asks a country for. */
export type CountryGroup = "nl" | "be" | "eu" | "other";

export function countryGroup(code: string | null | undefined): CountryGroup | null {
  if (!isCountryCode(code)) return null;
  if (code === "NL") return "nl";
  if (code === "BE") return "be";
  return code in EU_VAT ? "eu" : "other";
}

/** The country's name in a language; English is what the API stores beside the code. */
export function countryName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// The languages the product ships, plus the ways people write the two that matter most.
const NAME_LOCALES = ["en", "nl", "de", "fr", "es", "it", "uk", "cs"];
const ALIASES: Readonly<Record<string, string>> = {
  holland: "NL",
  "the netherlands": "NL",
  uk: "GB",
  "great britain": "GB",
  usa: "US",
  "united states of america": "US",
};
let byName: Map<string, string> | null = null;
const key = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The code of a country written as text: a code, or its name in one of the product's
 * languages. For details saved before the form had a list, and for callers that still
 * send a name. Null when the text names no country we know.
 */
export function countryCodeOf(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (isCountryCode(raw.toUpperCase())) return raw.toUpperCase();
  if (!byName) {
    byName = new Map(Object.entries(ALIASES));
    for (const locale of NAME_LOCALES)
      for (const code of COUNTRY_CODES) {
        const name = key(countryName(code, locale));
        if (!byName.has(name)) byName.set(name, code);
      }
  }
  return byName.get(key(raw)) ?? null;
}

const compact = (v: string) => v.replace(/[\s.\-/]/g, "").toUpperCase();

/**
 * A VAT number as it is stored: no spaces, dots or dashes, capitals, and for an EU country
 * its prefix in front when the person left it out. Outside the EU the number is kept as
 * typed, because we know no format for it.
 */
export function cleanVat(code: string | null | undefined, raw: string | null | undefined): string {
  const typed = (raw ?? "").trim();
  const rule = code ? EU_VAT[code] : undefined;
  if (!typed || !rule) return typed;
  // Greece's own code is GR; its VAT numbers start with EL.
  const value = code === "GR" ? compact(typed).replace(/^GR/, "EL") : compact(typed);
  return !value.startsWith(rule.prefix) && rule.body.test(value) ? `${rule.prefix}${value}` : value;
}

/** Whether a cleaned VAT number fits the country. Outside the EU anything is taken. */
export function vatFits(code: string | null | undefined, cleaned: string): boolean {
  const rule = code ? EU_VAT[code] : undefined;
  if (!rule) return true;
  return cleaned.startsWith(rule.prefix) && rule.body.test(cleaned.slice(rule.prefix.length));
}

/** A KvK number is eight digits. */
export const cleanKvk = (raw: string | null | undefined) => {
  const typed = (raw ?? "").trim();
  const digits = typed.replace(/[\s.]/g, "");
  return /^\d+$/.test(digits) ? digits : typed;
};
export const kvkFits = (cleaned: string) => /^\d{8}$/.test(cleaned);

/** A KBO number as Belgium writes it, 0123.456.789; a pasted VAT number loses its BE. */
export function cleanKbo(raw: string | null | undefined): string {
  const typed = (raw ?? "").trim();
  const digits = compact(typed).replace(/^BE/, "");
  return /^\d{10}$/.test(digits)
    ? `${digits.slice(0, 4)}.${digits.slice(4, 7)}.${digits.slice(7)}`
    : typed;
}
/** Ten digits, the first a 0 or a 1. */
export const kboFits = (cleaned: string) => /^[01]\d{9}$/.test(cleaned.replace(/\./g, ""));

/** A Peppol ID is a four digit scheme, a colon and the number in that scheme. */
export const cleanPeppol = (raw: string | null | undefined) => (raw ?? "").replace(/\s+/g, "");
export const peppolFits = (cleaned: string) => /^\d{4}:[A-Za-z0-9._~-]+$/.test(cleaned);

export const DELIVERIES = ["peppol", "email", "portal"] as const;
export type Delivery = (typeof DELIVERIES)[number];

/** The answers the rules read. Text is as typed; empty and null both mean not given. */
export interface BillingAnswers {
  readonly country_code?: string | null | undefined;
  readonly vat_id?: string | null | undefined;
  readonly no_vat_number?: boolean | null | undefined;
  readonly kvk_number?: string | null | undefined;
  readonly kbo_number?: string | null | undefined;
  readonly peppol_id?: string | null | undefined;
  readonly invoice_delivery?: Delivery | null | undefined;
  readonly invoice_portal?: string | null | undefined;
}

export type BillingField =
  | "country_code"
  | "vat_id"
  | "no_vat_number"
  | "kvk_number"
  | "kbo_number"
  | "peppol_id"
  | "invoice_portal";

/** `missing`: nothing was given where something is needed. `format`: it does not look right. */
export interface BillingProblem {
  readonly field: BillingField;
  readonly kind: "missing" | "format";
}

/** The numbers as they are stored, and whether the VAT question was asked and answered. */
export interface CleanBilling {
  readonly vat_id: string | null;
  /** true: they said they have none. false: asked, and they gave one. null: not asked. */
  readonly no_vat_number: boolean | null;
  readonly kvk_number: string | null;
  readonly kbo_number: string | null;
  readonly peppol_id: string | null;
  readonly invoice_portal: string | null;
}

/**
 * Checks the answers that depend on the country and on how invoices arrive, and gives the
 * numbers back as they are stored. Every problem is listed at once, each on its own field,
 * so nobody fixes one to be told about the next.
 */
export function checkBilling(a: BillingAnswers): {
  problems: BillingProblem[];
  clean: CleanBilling;
} {
  const problems: BillingProblem[] = [];
  const group = countryGroup(a.country_code);
  if (!group) problems.push({ field: "country_code", kind: "missing" });

  const said = (group === "be" || group === "eu") && a.no_vat_number === true;
  const vat = cleanVat(a.country_code, a.vat_id);
  const kvk = cleanKvk(a.kvk_number);
  const kbo = cleanKbo(a.kbo_number);
  const peppol = cleanPeppol(a.peppol_id);
  const portal = (a.invoice_portal ?? "").trim();

  if (vat && said) problems.push({ field: "no_vat_number", kind: "format" });
  else if (vat && !vatFits(a.country_code, vat)) problems.push({ field: "vat_id", kind: "format" });
  if (kvk && !kvkFits(kvk)) problems.push({ field: "kvk_number", kind: "format" });
  if (kbo && !kboFits(kbo)) problems.push({ field: "kbo_number", kind: "format" });

  if (group === "nl" && !vat && !kvk)
    problems.push({ field: "kvk_number", kind: "missing" }, { field: "vat_id", kind: "missing" });
  if ((group === "be" || group === "eu") && !vat && !said)
    problems.push({ field: "vat_id", kind: "missing" });
  if (group === "be" && said && !kbo) problems.push({ field: "kbo_number", kind: "missing" });

  if (peppol && !peppolFits(peppol)) problems.push({ field: "peppol_id", kind: "format" });
  if (a.invoice_delivery === "portal" && !portal)
    problems.push({ field: "invoice_portal", kind: "missing" });

  return {
    problems,
    clean: {
      vat_id: vat || null,
      no_vat_number: group === "be" || group === "eu" ? said : null,
      kvk_number: kvk || null,
      kbo_number: kbo || null,
      peppol_id: peppol || null,
      invoice_portal: a.invoice_delivery === "portal" ? portal || null : null,
    },
  };
}

/**
 * Whether stored details name everything an invoice needs about who the customer is: a
 * number, the statement that there is no VAT number, or a country outside the EU, where we
 * ask for none. Details saved before the country was a code are judged by their numbers.
 */
export function identified(b: {
  readonly country_code: string | null;
  readonly country: string | null;
  readonly vat_id: string | null;
  readonly no_vat_number: boolean | null;
  readonly kvk_number: string | null;
  readonly kbo_number: string | null;
}): boolean {
  const filled = (v: string | null) => v !== null && v.trim() !== "";
  if (filled(b.vat_id) || filled(b.kvk_number) || filled(b.kbo_number)) return true;
  if (b.no_vat_number === true) return true;
  return countryGroup(b.country_code ?? countryCodeOf(b.country)) === "other";
}
