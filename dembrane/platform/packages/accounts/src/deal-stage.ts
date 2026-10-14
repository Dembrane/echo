import type { DocumentRow } from "./storage";

/**
 * Where an account's deal stands, under the names the team uses everywhere (Attio, sam's
 * notices, the morning list). It is read from what the account already holds, its newest
 * offer, the billing details, the documents that go with the offer and the invoices
 * mirrored from Exact, so it cannot disagree with the account page. Nothing stores it.
 *
 * `lost` is a declined offer. `parked` is a person's call that the product holds no fact
 * for, so it is never derived here; it stays in the list of names so every reader shares
 * one list.
 */
export const DEAL_STAGES = [
  "in_progress",
  "offer_drafted",
  "offer_sent",
  "offer_accepted",
  "invoice_sent",
  "paid",
  "lost",
  "parked",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export type StageDocument = Pick<
  DocumentRow,
  "kind" | "status" | "createdAt" | "signedAt" | "dpaTextId" | "invoiceStatus"
>;

export interface StageFacts {
  /** The organisation is managed as an account (it has a stage of its own). */
  readonly isAccount: boolean;
  readonly documents: readonly StageDocument[];
  /** Every billing and invoice detail the invoice needs is saved. */
  readonly billingComplete: boolean;
}

const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);

export function dealStage(f: StageFacts): DealStage | null {
  // The newest offer that still stands decides; a withdrawn one says nothing.
  const offer = f.documents
    .filter((x) => x.kind === "offer" && x.status !== "void")
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (!offer) return f.isAccount ? "in_progress" : null;
  if (offer.status === "draft") return "offer_drafted";
  if (offer.status === "declined") return "lost";
  if (offer.status !== "signed") return "offer_sent";
  // Accepted means nothing is left for the customer: signed, the details the invoice needs
  // saved, and the separate DPA signed where the offer came with one.
  const dpaOpen = f.documents.some(
    (x) =>
      x.kind === "dpa" &&
      x.dpaTextId === offer.dpaTextId &&
      (x.status === "sent" || x.status === "viewed"),
  );
  if (!f.billingComplete || dpaOpen) return "offer_sent";
  // An invoice belongs to this offer when it came after the signature.
  const invoices = f.documents.filter(
    (x) =>
      x.kind === "invoice" &&
      x.status !== "void" &&
      x.invoiceStatus !== "void" &&
      time(x.createdAt) >= time(offer.signedAt),
  );
  if (!invoices.length) return "offer_accepted";
  return invoices.every((x) => x.invoiceStatus === "paid") ? "paid" : "invoice_sent";
}
