import { ValidationError } from "@dembrane/core";

/**
 * Offer lines and their totals, in integer cents so no amount is ever a float. A quantity
 * may have two decimals (1.5 days, 0.25 hours): it is counted in hundredths, and the line's
 * amount is rounded to the cent half away from zero (half up for any positive amount). VAT
 * is a rate in basis points (2100 is 21%) and is rounded per line the same way, which is
 * how the invoice lines in Exact round; the document total is the sum of the lines that
 * are charged, so section subtotals and the total always agree to the cent.
 */

/**
 * A line that is not charged: `optional` shows its price apart from the rest and counts
 * only once the customer asks for it (in a revised offer); `included` is shown at no
 * charge ("Onboarding, included") and has no price. Absent: charged, as every line was.
 */
export const LINE_KINDS = ["optional", "included"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface OfferLine {
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
  readonly vat_rate_bps: number;
  readonly kind?: LineKind | undefined;
  /** The heading the line sits under; absent on an offer without sections. */
  readonly section?: string | undefined;
}

/** The most decimals a quantity may have: hundredths, as 0.25 hours or 1.5 days. */
export const QUANTITY_DECIMALS = 2;

/**
 * A quantity in hundredths (1.5 is 150), or null when it is not above zero with at most
 * two decimals. Read with a tolerance, since 0.29 * 100 is 28.999999999999996 as a float.
 */
export function hundredthsOf(quantity: number): number | null {
  if (!Number.isFinite(quantity)) return null;
  const h = Math.round(quantity * 100);
  if (Math.abs(quantity * 100 - h) > 1e-6 || h < 1 || !Number.isSafeInteger(h)) return null;
  return h;
}

/** n / d for integers, rounded half away from zero, without leaving integers. */
function divRound(n: number, d: number): number {
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  return sign * (abs - q * d >= d / 2 ? q + 1 : q);
}

/** A line's amount before VAT: quantity times unit price, rounded to the cent. */
export function netOf(quantity: number, unitPriceCents: number): number | null {
  const h = hundredthsOf(quantity);
  if (h === null) return null;
  const product = h * unitPriceCents;
  return Number.isSafeInteger(product) ? divRound(product, 100) : Number.NaN;
}

/** Whether a line counts in the totals and on the invoice. */
export const charged = (l: Pick<OfferLine, "kind">) => !l.kind;

export interface PricedLine extends OfferLine {
  readonly net_cents: number;
  readonly vat_cents: number;
  readonly total_cents: number;
}

export interface Totals {
  readonly lines: PricedLine[];
  readonly subtotal_cents: number;
  readonly vat_cents: number;
  readonly total_cents: number;
}

/**
 * How VAT applies to an offer or invoice: Dutch VAT on the lines, reverse-charged to a
 * business elsewhere in the EU, or none for a service supplied outside the EU. The last two
 * carry only 0% lines and say why on the document.
 */
export const VAT_TREATMENTS = ["standard", "reverse_charge", "outside_eu"] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** Whether lines fit the treatment: reverse charge and outside the EU have no VAT. */
export const fitsVatTreatment = (t: VatTreatment, lines: readonly OfferLine[]) =>
  t === "standard" || lines.every((l) => l.vat_rate_bps === 0);

/** Rates we invoice at: NL standard and reduced, and zero (reverse charge, outside the EU). */
export const VAT_RATES_BPS = [0, 900, 2100] as const;

/** round(n * bps / 10000) half away from zero, without leaving integers. */
export function vatOf(netCents: number, bps: number): number {
  return divRound(netCents * bps, 10_000);
}

export function priceLines(lines: readonly OfferLine[]): Totals {
  if (!lines.length) throw new ValidationError("offer.no_lines");
  const priced = lines.map((l, i) => {
    if (hundredthsOf(l.quantity) === null)
      throw new ValidationError("offer.line_quantity", { params: { line: i + 1 } });
    if (!Number.isSafeInteger(l.unit_price_cents))
      throw new ValidationError("offer.line_unit_price", { params: { line: i + 1 } });
    if (!(VAT_RATES_BPS as readonly number[]).includes(l.vat_rate_bps))
      throw new ValidationError("offer.line_vat_rate", {
        params: { line: i + 1, rates: VAT_RATES_BPS.join(", ") },
      });
    if (l.kind === "included" && l.unit_price_cents !== 0)
      throw new ValidationError("offer.included_has_price", { params: { line: i + 1 } });
    const net = netOf(l.quantity, l.unit_price_cents) as number;
    if (!Number.isSafeInteger(net))
      throw new ValidationError("offer.line_amount_too_large", { params: { line: i + 1 } });
    const vat = vatOf(net, l.vat_rate_bps);
    return { ...l, net_cents: net, vat_cents: vat, total_cents: net + vat };
  });
  // An optional line carries its own amount, for the customer to see; only charged lines add up.
  const counted = priced.filter(charged);
  const subtotal = counted.reduce((s, l) => s + l.net_cents, 0);
  const vat = counted.reduce((s, l) => s + l.vat_cents, 0);
  // A discount line may be negative (a scholarship); the offer as a whole may not.
  if (subtotal + vat < 0) throw new ValidationError("offer.negative_total");
  return { lines: priced, subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}

/**
 * An offer that goes to a customer asks for money: every line carries an amount (a discount
 * may be negative), except one included at no charge, and the charged lines come to more
 * than zero, so an offer of optional lines alone is refused. A missing price is a question
 * for whoever drafts the offer, never a line that reads 0,00. Checked when an offer is
 * drafted or changed, not when an old one is rendered.
 *
 * `noCharge` is the one way to an offer of zero (a free pilot, a scholarship, an agreement
 * with no price): staff choose it, a line may then be 0, and the total must be exactly zero,
 * so a forgotten price never slips through as a free offer, nor a price into a free one.
 */
export function requireAmounts(lines: readonly OfferLine[], noCharge = false): Totals {
  const totals = priceLines(lines);
  checkSections(lines);
  if (noCharge) {
    if (totals.total_cents !== 0) throw new ValidationError("offer.no_charge_total");
    return totals;
  }
  totals.lines.forEach((l, i) => {
    if (l.unit_price_cents === 0 && l.kind !== "included")
      throw new ValidationError("offer.line_no_amount", { params: { line: i + 1 } });
  });
  if (totals.total_cents === 0) throw new ValidationError("offer.zero_total");
  return totals;
}

/** A group of lines under one heading, with what its charged lines come to before VAT. */
export interface Section<L extends OfferLine = OfferLine> {
  /** The heading; null for an offer without sections, whose lines form one group. */
  readonly title: string | null;
  /** The lines in order, each with its index in the offer. */
  readonly lines: readonly { readonly line: L; readonly index: number }[];
  readonly subtotal_cents: number;
}

/**
 * Sections an offer's lines fall into, in order. Either no line has a section, or every
 * line has one and each section's lines sit together: a heading is written once, over its
 * lines, never split by another. Refuses anything else.
 */
export function checkSections(lines: readonly OfferLine[]): void {
  const named = lines.filter((l) => l.section);
  if (!named.length) return;
  if (named.length !== lines.length) {
    const first = lines.findIndex((l) => !l.section);
    throw new ValidationError("offer.section_missing", { params: { line: first + 1 } });
  }
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const title = l.section as string;
    if (i > 0 && lines[i - 1]?.section === title) return;
    if (seen.has(title))
      throw new ValidationError("offer.section_split", { params: { section: title } });
    seen.add(title);
  });
}

/**
 * The lines in their sections, with the subtotal of each: the charged lines' amounts
 * before VAT, which together make the offer's subtotal exactly, since every line is
 * rounded on its own.
 */
export function sectionsOf<L extends PricedLine>(lines: readonly L[]): Section<L>[] {
  const out: { title: string | null; lines: { line: L; index: number }[] }[] = [];
  lines.forEach((line, index) => {
    const title = line.section ?? null;
    const last = out.at(-1);
    if (last && last.title === title) last.lines.push({ line, index });
    else out.push({ title, lines: [{ line, index }] });
  });
  return out.map((s) => ({
    ...s,
    subtotal_cents: s.lines.reduce(
      (sum, { line }) => sum + (charged(line) ? line.net_cents : 0),
      0,
    ),
  }));
}

/** 123456 cents as "1.234,56" for Dutch-reading documents, with the currency code before it. */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = String(abs % 100).padStart(2, "0");
  return `${currency} ${sign}${whole},${frac}`;
}

/** 2100 as "21%", 950 as "9.5%". */
export function formatRate(bps: number): string {
  return `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2).replace(/0+$/, "")}%`;
}
