import type { AccountsDeps, Conn } from "./deps";
import { billingPayload, documentPayload, emit, orgPayload, signaturePayload } from "./events";
import { accountPageUrl, dashboardBase } from "./jobs";
import type { OfferContent } from "./offer";
import {
  type BillingRow,
  type DocumentRow,
  type FieldRow,
  type OrgRow,
  type SignatureRow,
  store,
} from "./storage";
import { billingComplete } from "./tasks";
import { staffBase } from "./views";

/** What a signed offer's invoice request can still wait for. */
export type InvoiceWait = "billing_details" | "dpa";

/**
 * What a signed offer still waits for before its invoice is asked for.
 *
 * The DPA counts when it is a document of its own: the offer says so, or its signer said
 * they may not agree to data processing, so the DPA went out on its own (openDpa). An
 * offer whose signer agreed to the DPA with the offer waits for no second signature. A
 * separate DPA is signed once the organisation has a signed DPA on the text the offer
 * pinned, or one written for this customer (its own text or PDF), which stands in for it.
 */
export function invoiceWaits(
  offer: DocumentRow,
  sig: SignatureRow,
  billing: BillingRow | null,
  docs: readonly DocumentRow[],
): InvoiceWait[] {
  const waits: InvoiceWait[] = [];
  if (!billingComplete(billing)) waits.push("billing_details");
  const content = offer.content as OfferContent | null;
  // The customer's own processing terms stand in for our DPA: there is none to wait for.
  const separate =
    !content?.processing_terms && (Boolean(content?.dpa_separate) || !sig.dpaAuthorised);
  const dpaSigned = docs.some(
    (x) =>
      x.kind === "dpa" &&
      x.status === "signed" &&
      (x.dpaTextId === offer.dpaTextId || x.dpaTextId === null),
  );
  if (separate && !dpaSigned) waits.push("dpa");
  return waits;
}

/** The signed offers that have an amount to invoice and were not asked for yet. */
export function uninvoicedOffers(
  docs: readonly DocumentRow[],
  asked: ReadonlySet<string>,
): DocumentRow[] {
  return docs.filter(
    (x) =>
      x.kind === "offer" && x.status === "signed" && (x.totalCents ?? 0) > 0 && !asked.has(x.id),
  );
}

/**
 * "Send the invoice" is a person's step, and it can start only when every required
 * document exists: a signed offer, complete billing details and, where the DPA is a
 * document of its own, that DPA signed too (invoiceWaits). They arrive in any order (a new
 * customer signs first, because the billing details task opens on the signature; a
 * returning one has details on file; the DPA may be signed by someone else, later), so
 * each of the three writes calls this, and it asks once per offer. Until then the timeline
 * says what the offer waits for, one row for each change of the answer.
 *
 * What it emits, `account.invoice.requested`, carries everything the invoice needs: what
 * was signed and for how much, who signed, who to invoice, and where to look. sam turns it
 * into the invoice in Exact, which renders, sends and tracks it; sam then mirrors Exact's
 * invoice and its PDF back with PUT .../invoices/:exactId, so the customer finds it on the
 * account page. The
 * timeline row is the record that an offer was asked for, so saving the billing details
 * again asks nothing new. An offer of zero (drafted before offers had to carry amounts) has
 * nothing to invoice and is left out.
 *
 * The caller holds the organisation's row (store.lockOrg) from the start of its
 * transaction: without it a signature and a billing save that commit at the same moment
 * would each see the other missing, and nobody would be asked.
 */
export async function requestInvoices(d: AccountsDeps, tx: Conn, org: OrgRow): Promise<string[]> {
  // Nobody to ask yet: the row is the record that someone was asked, so none is written,
  // and the request goes out with the next signature or billing save once sam takes it.
  if (!d.settings.offerMessages) return [];
  const docs = await store.documents(tx, org.id);
  const signed = uninvoicedOffers(docs, await store.eventSubjects(tx, org.id, "invoice.requested"));
  if (!signed.length) return [];
  const billing = await store.billing(tx, org.id);
  const said = await store.latestDetails(tx, org.id, "invoice.waiting");
  const out: string[] = [];
  for (const doc of signed) {
    const sig = await store.signatureOf(tx, doc.id);
    if (!sig) continue;
    const waits = invoiceWaits(doc, sig, billing, docs);
    if (waits.length) {
      const before = (said.get(doc.id) as { waits_for?: string[] } | null)?.waits_for ?? [];
      if (before.join() !== waits.join())
        await emit(d, tx, {
          orgId: org.id,
          actor: { kind: "system", userId: null },
          type: "invoice.waiting",
          subject: { type: "document", id: doc.id },
          detail: { reference: doc.reference, waits_for: waits },
        });
      continue;
    }
    const signedPdf = `${staffBase(org.id)}/documents/${doc.id}/signed.pdf`;
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "system", userId: null },
      type: "invoice.requested",
      subject: { type: "document", id: doc.id },
      detail: { reference: doc.reference, total_cents: doc.totalCents, currency: doc.currency },
      webhook: {
        event: "account.invoice.requested",
        org: orgPayload(org),
        document: documentPayload(doc),
        signature: signaturePayload(sig, signedPdf),
        billing: billingPayload(billing),
        invoice: invoicePayload(doc, billing, signedReference(await store.fields(tx, doc.id), sig)),
        links: {
          /** The organisation's card in the staff console, as a dashboard address. */
          account: staffAccountUrl(d.settings.dashboardUrl, org.id),
          /** The offer as staff see it: the PDF, its state, and the signed copy. */
          document: staffDocumentUrl(d.settings.dashboardUrl, org.id, doc.id),
          /** Staff API path of the signed PDF; fetched with the staff key. */
          signed_pdf: signedPdf,
          /** Where sam puts Exact's invoice and its PDF, with Exact's id in place of :exactId. */
          mirror: `${staffBase(org.id)}/invoices/:exactId`,
        },
      },
    });
    out.push(doc.id);
  }
  return out;
}

/** The PO or reference the signer left in the offer's reference field, frozen with it. */
export function signedReference(fields: readonly FieldRow[], sig: SignatureRow): string | null {
  const field = fields.find((f) => f.kind === "text" && f.key === "po_number");
  const value = field ? (sig.fieldValues as Record<string, unknown>)[field.id] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * What Exact's invoice is made of, as the offer said it: its language, how VAT applies,
 * the customer's PO number, and the lines with the bullets under each (seats, months,
 * the period), which the invoice line carries as its extra description. The priced lines
 * and totals are on `document`; Exact rounds VAT per line the same way (money.ts).
 *
 * The PO is this offer's: what the signer confirmed, else what the offer carried, and only
 * when it had none the organisation's billing PO, which a second order would otherwise reuse.
 */
export function invoicePayload(
  doc: DocumentRow,
  billing: BillingRow | null,
  signed: string | null,
) {
  const content = doc.content as OfferContent | null;
  return {
    language: doc.language,
    vat_treatment: content?.vat_treatment ?? "standard",
    po_number: signed ?? content?.customer_reference ?? billing?.po_number ?? null,
    items: content?.items ?? [],
  };
}

/** The organisation's card in the staff console. */
export const staffAccountUrl = (dashboardUrl: string, orgId: string) =>
  `${dashboardBase(dashboardUrl)}/admin/accounts/${orgId}`;

/** One document as staff open it: the page where a draft offer is reviewed and sent. */
export const staffDocumentUrl = (dashboardUrl: string, orgId: string, docId: string) =>
  `${staffAccountUrl(dashboardUrl, orgId)}/documents/${docId}`;

/** Where the customer signs a document. */
export const customerSignUrl = (dashboardUrl: string, orgId: string, docId: string) =>
  `${accountPageUrl(dashboardUrl, orgId)}/documents/${docId}/sign`;
