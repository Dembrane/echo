import { ValidationError } from "@dembrane/core";
import { charged, type OfferLine, priceLines, vatOf } from "./money";

/**
 * How an offer is invoiced when it is not all at once: in equal monthly parts (the
 * subscription shape, a year's licence as twelve invoices), or in instalments that each
 * fall on signing or on a date and carry a share of the total (half on signing, half on
 * 1 December). One in eleven signed offers was invoiced in parts, each part by hand, so the
 * plan is agreed on the offer and echo asks for each part's invoice when it falls due.
 * Absent on an offer, it is invoiced at once, as every offer was before.
 */
export type InvoicePlan =
  | { readonly kind: "monthly"; readonly parts: number }
  | { readonly kind: "instalments"; readonly parts: readonly Instalment[] };

export interface Instalment {
  /** "signing", or the ISO date the part falls due. */
  readonly on: string;
  /** Its share of the total in basis points; the shares add up to 10000. */
  readonly share_bps: number;
}

/** When a part falls due: on signing, a number of months after it, or on a date. */
export type PartDue =
  | { readonly kind: "signing" }
  | { readonly kind: "months_after"; readonly months: number }
  | { readonly kind: "date"; readonly date: string };

/** One part of an offer's invoice, with its amounts in cents. */
export interface InvoicePart {
  /** From 1. */
  readonly number: number;
  readonly of: number;
  readonly due: PartDue;
  readonly subtotal_cents: number;
  readonly vat_cents: number;
  readonly total_cents: number;
}

export const MONTHLY_PARTS = { min: 2, max: 24 } as const;
export const INSTALMENTS = { min: 2, max: 12 } as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (v: string) =>
  ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Checks a plan against the offer's lines and gives it back as stored. Parts are cut from
 * one total, so the charged lines carry one VAT rate: a part's VAT is that rate on its
 * amount, as the invoice in Exact will compute it.
 */
export function checkInvoicePlan(plan: InvoicePlan, lines: readonly OfferLine[]): InvoicePlan {
  const rates = new Set(lines.filter(charged).map((l) => l.vat_rate_bps));
  if (rates.size > 1) throw new ValidationError("offer.invoice_parts_vat");
  if (plan.kind === "monthly") {
    if (
      !Number.isInteger(plan.parts) ||
      plan.parts < MONTHLY_PARTS.min ||
      plan.parts > MONTHLY_PARTS.max
    )
      throw new ValidationError("offer.invoice_parts_count", {
        params: { min: MONTHLY_PARTS.min, max: MONTHLY_PARTS.max },
      });
    return { kind: "monthly", parts: plan.parts };
  }
  const parts = plan.parts;
  if (parts.length < INSTALMENTS.min || parts.length > INSTALMENTS.max)
    throw new ValidationError("offer.invoice_parts_count", {
      params: { min: INSTALMENTS.min, max: INSTALMENTS.max },
    });
  let last = "";
  parts.forEach((p, i) => {
    // Only the first falls on signing; the rest follow it in date order.
    const fits =
      p.on === "signing" ? i === 0 : isDate(p.on) && (last === "signing" || p.on >= last);
    if (!fits) throw new ValidationError("offer.invoice_part_when", { params: { part: i + 1 } });
    if (!Number.isInteger(p.share_bps) || p.share_bps < 1)
      throw new ValidationError("offer.invoice_part_share", { params: { part: i + 1 } });
    last = p.on;
  });
  const sum = parts.reduce((s, p) => s + p.share_bps, 0);
  if (sum !== 10_000)
    throw new ValidationError("offer.invoice_shares_total", {
      params: { total: `${sum / 100}%` },
    });
  return { kind: "instalments", parts: parts.map((p) => ({ on: p.on, share_bps: p.share_bps })) };
}

/**
 * The parts of an offer's invoice. Each takes its share of the subtotal rounded down to the
 * cent and its VAT at the offer's one rate; the last takes what is left of both, so the
 * parts add up to the offer's totals exactly.
 */
export function invoiceParts(plan: InvoicePlan, lines: readonly OfferLine[]): InvoicePart[] {
  const totals = priceLines(lines);
  const rate = lines.find(charged)?.vat_rate_bps ?? 0;
  const shares: { due: PartDue; bps: number }[] =
    plan.kind === "monthly"
      ? Array.from({ length: plan.parts }, (_, i) => ({
          due: i === 0 ? { kind: "signing" } : { kind: "months_after", months: i },
          bps: 0,
        }))
      : plan.parts.map((p) => ({
          due: p.on === "signing" ? { kind: "signing" } : { kind: "date", date: p.on },
          bps: p.share_bps,
        }));
  const of = shares.length;
  let net = 0;
  let vat = 0;
  return shares.map((s, i) => {
    const last = i === of - 1;
    const share =
      plan.kind === "monthly"
        ? Math.floor(totals.subtotal_cents / of)
        : Math.floor((totals.subtotal_cents * s.bps) / 10_000);
    const partNet = last ? totals.subtotal_cents - net : share;
    const partVat = last ? totals.vat_cents - vat : vatOf(partNet, rate);
    net += partNet;
    vat += partVat;
    return {
      number: i + 1,
      of,
      due: s.due,
      subtotal_cents: partNet,
      vat_cents: partVat,
      total_cents: partNet + partVat,
    };
  });
}

/** The calendar day in Amsterdam, where dembrane invoices, as an ISO date. */
export const amsterdamDay = (at: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** An ISO date some months later, on the same day or the month's last when it has fewer. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, days));
  return first.toISOString().slice(0, 10);
}

/** The day a part falls due for an offer signed on `signedOn` (an ISO date). */
export function dueOn(due: PartDue, signedOn: string): string {
  if (due.kind === "signing") return signedOn;
  if (due.kind === "months_after") return addMonths(signedOn, due.months);
  // A date before the signature falls due the day it is signed.
  return due.date < signedOn ? signedOn : due.date;
}
