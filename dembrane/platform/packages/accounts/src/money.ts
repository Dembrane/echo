import { ValidationError } from "@dembrane/core";

/**
 * Offer lines and their totals, in integer cents so no amount is ever a float. VAT is a
 * rate in basis points (2100 is 21%) and is rounded per line, half away from zero, which
 * is how the invoice lines in Exact round; the document total is the sum of the lines.
 */
export interface OfferLine {
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
  readonly vat_rate_bps: number;
}

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

/** Rates we invoice at: NL standard and reduced, and zero (reverse charge, outside the EU). */
export const VAT_RATES_BPS = [0, 900, 2100] as const;

/** round(n * bps / 10000) half away from zero, without leaving integers. */
export function vatOf(netCents: number, bps: number): number {
  const scaled = netCents * bps;
  const sign = scaled < 0 ? -1 : 1;
  const abs = Math.abs(scaled);
  const q = Math.floor(abs / 10_000);
  const r = abs - q * 10_000;
  return sign * (r >= 5_000 ? q + 1 : q);
}

export function priceLines(lines: readonly OfferLine[]): Totals {
  if (!lines.length) throw new ValidationError("offer.no_lines");
  const priced = lines.map((l, i) => {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1)
      throw new ValidationError("offer.line_quantity", { params: { line: i + 1 } });
    if (!Number.isSafeInteger(l.unit_price_cents))
      throw new ValidationError("offer.line_unit_price", { params: { line: i + 1 } });
    if (!(VAT_RATES_BPS as readonly number[]).includes(l.vat_rate_bps))
      throw new ValidationError("offer.line_vat_rate", {
        params: { line: i + 1, rates: VAT_RATES_BPS.join(", ") },
      });
    const net = l.quantity * l.unit_price_cents;
    if (!Number.isSafeInteger(net))
      throw new ValidationError("offer.line_amount_too_large", { params: { line: i + 1 } });
    const vat = vatOf(net, l.vat_rate_bps);
    return { ...l, net_cents: net, vat_cents: vat, total_cents: net + vat };
  });
  const subtotal = priced.reduce((s, l) => s + l.net_cents, 0);
  const vat = priced.reduce((s, l) => s + l.vat_cents, 0);
  // A discount line may be negative (a scholarship); the offer as a whole may not.
  if (subtotal + vat < 0) throw new ValidationError("offer.negative_total");
  return { lines: priced, subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
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
