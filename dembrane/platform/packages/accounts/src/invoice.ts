import type { AccountsDeps, Conn } from "./deps";
import { billingPayload, documentPayload, emit, orgPayload, signaturePayload } from "./events";
import { accountPageUrl } from "./jobs";
import { type OrgRow, store } from "./storage";
import { billingComplete } from "./tasks";
import { staffBase } from "./views";

/**
 * "Send the invoice" is a person's step, and it can start only when two things exist: a
 * signed offer and complete billing details. They arrive in either order (a new customer
 * signs first, because the billing details task opens on the signature; a returning one
 * has details on file), so both writes call this, and it asks once per offer.
 *
 * What it emits, `account.invoice.requested`, carries everything the invoice needs: what
 * was signed and for how much, who signed, who to invoice, and where to look. The
 * timeline row is the record that an offer was asked for, so saving the billing details
 * again asks nothing new. An offer of zero has nothing to invoice and is left out.
 *
 * The caller holds the organisation's row (store.lockOrg) from the start of its
 * transaction: without it a signature and a billing save that commit at the same moment
 * would each see the other missing, and nobody would be asked.
 */
export async function requestInvoices(d: AccountsDeps, tx: Conn, org: OrgRow): Promise<string[]> {
  // Nobody to ask yet: the row is the record that someone was asked, so none is written,
  // and the request goes out with the next signature or billing save once sam takes it.
  if (!d.settings.offerMessages) return [];
  const billing = await store.billing(tx, org.id);
  if (!billingComplete(billing)) return [];
  const signed = (await store.documents(tx, org.id)).filter(
    (x) => x.kind === "offer" && x.status === "signed" && (x.totalCents ?? 0) > 0,
  );
  if (!signed.length) return [];
  const asked = await store.eventSubjects(tx, org.id, "invoice.requested");
  const out: string[] = [];
  for (const doc of signed) {
    if (asked.has(doc.id)) continue;
    const sig = await store.signatureOf(tx, doc.id);
    if (!sig) continue;
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
        links: {
          /** The organisation's card in the staff console, as a dashboard address. */
          account: staffAccountUrl(d.settings.dashboardUrl, org.id),
          /** The offer as staff see it: the PDF, its state, and the signed copy. */
          document: staffDocumentUrl(d.settings.dashboardUrl, org.id, doc.id),
          /** Staff API path of the signed PDF; fetched with the staff key. */
          signed_pdf: signedPdf,
        },
      },
    });
    out.push(doc.id);
  }
  return out;
}

const base = (dashboardUrl: string) => dashboardUrl.replace(/\/+$/, "");

/** The organisation's card in the staff console. */
export const staffAccountUrl = (dashboardUrl: string, orgId: string) =>
  `${base(dashboardUrl)}/admin/accounts/${orgId}`;

/** One document as staff open it: the page where a draft offer is reviewed and sent. */
export const staffDocumentUrl = (dashboardUrl: string, orgId: string, docId: string) =>
  `${staffAccountUrl(dashboardUrl, orgId)}/documents/${docId}`;

/** Where the customer signs a document. */
export const customerSignUrl = (dashboardUrl: string, orgId: string, docId: string) =>
  `${accountPageUrl(dashboardUrl, orgId)}/documents/${docId}/sign`;
