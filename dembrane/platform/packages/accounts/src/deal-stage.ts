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
  "kind" | "status" | "createdAt" | "sentAt" | "signedAt" | "dpaTextId" | "invoiceStatus"
>;

export interface StageFacts {
  /** The organisation is managed as an account (it has a stage of its own). */
  readonly isAccount: boolean;
  readonly documents: readonly StageDocument[];
  /** Every billing and invoice detail the invoice needs is saved. */
  readonly billingComplete: boolean;
  /** When the billing details were last saved. */
  readonly billingAt?: Date | string | null;
}

const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);

/** The newest offer that still stands decides; a withdrawn one says nothing. */
const standingOffer = (f: StageFacts) =>
  f.documents
    .filter((x) => x.kind === "offer" && x.status !== "void")
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];

export function dealStage(f: StageFacts): DealStage | null {
  const offer = standingOffer(f);
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

/** When the deal reached each step the stage is made of; null until it has. */
export interface DealMilestones {
  readonly offer_drafted: string | null;
  readonly offer_sent: string | null;
  readonly signed: string | null;
  readonly billing_details: string | null;
  /** Every other document that goes with the offer is signed, such as its separate DPA. */
  readonly documents_signed: string | null;
  readonly invoice_sent: string | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The dates behind the stage, from the same facts, so the list and the card can show how far
 * a deal has come step by step under the names Attio uses.
 */
export function dealMilestones(f: StageFacts): DealMilestones {
  const offer = standingOffer(f);
  const none = {
    offer_drafted: null,
    offer_sent: null,
    signed: null,
    billing_details: null,
    documents_signed: null,
    invoice_sent: null,
  };
  if (!offer) return none;
  const signed = offer.status === "signed" ? iso(offer.signedAt) : null;
  // The DPA that went out with the offer; an offer without one needs only its own signature.
  const others = f.documents.filter(
    (x) => x.kind === "dpa" && x.dpaTextId === offer.dpaTextId && x.status !== "void",
  );
  const documentsSigned = !signed
    ? null
    : others.every((x) => x.status === "signed")
      ? iso([offer, ...others].map((x) => x.signedAt).sort((a, b) => time(b) - time(a))[0] ?? null)
      : null;
  const invoice = f.documents
    .filter(
      (x) =>
        signed &&
        x.kind === "invoice" &&
        x.status !== "void" &&
        x.invoiceStatus !== "void" &&
        time(x.createdAt) >= time(offer.signedAt),
    )
    .sort((a, b) => time(a.createdAt) - time(b.createdAt))[0];
  return {
    offer_drafted: iso(offer.createdAt),
    offer_sent: offer.status === "draft" ? null : iso(offer.sentAt),
    signed,
    billing_details: f.billingComplete ? iso(f.billingAt) : null,
    documents_signed: documentsSigned,
    invoice_sent: invoice ? iso(invoice.createdAt) : null,
  };
}
