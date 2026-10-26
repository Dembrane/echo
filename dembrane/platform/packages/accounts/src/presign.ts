import { newId } from "@dembrane/core";
import type { AccountsDeps, Conn } from "./deps";
import { type DembraneSignature, type DembraneSigner, printedDay } from "./offer";
import type { SignedBy } from "./pdf";
import { type DocumentRow, type SignatureRow, store } from "./storage";

/**
 * dembrane signs what it sends. With a signer chosen on the offer, or a signatory configured,
 * every offer and every DPA echo sends carries dembrane's signature from the moment it is sent: the PDF prints it under the
 * customer's blanks (name, role, date, signed electronically) and it is its own insert-only
 * signature row in the `dembrane` slot. The customer's signature then completes the document
 * and nobody at dembrane has a step after it. Without either, documents go out as before.
 */

/**
 * dembrane's signature as applied now: by the signer staff chose on the offer, else the
 * configured signatory, else null. A configured name may be left out and is then read from
 * the signatory's own account; with neither, nothing is signed.
 */
export async function dembraneSignature(
  d: AccountsDeps,
  c: Conn,
  now: Date,
  chosen?: DembraneSigner | null,
): Promise<DembraneSignature | null> {
  if (chosen) return { ...chosen, signed_at: now.toISOString() };
  const s = d.settings.signatory;
  if (!s?.email) return null;
  const email = s.email.trim().toLowerCase();
  let name = s.name?.trim() || null;
  if (!name) {
    const user = await store.identityByEmail(c, email);
    name = user ? ((await store.userNames(c, [user.id])).get(user.id) ?? null) : null;
  }
  if (!name) {
    d.logger.warn(
      { signal: "accounts.signatory_unnamed" },
      "dembrane's signatory has no name configured and no account to read it from; documents go out without dembrane's signature",
    );
    return null;
  }
  return { name, role: s.role?.trim() || null, email, signed_at: now.toISOString() };
}

/** dembrane's signature as a text document (the DPA) prints it. */
export const signedBy = (d: AccountsDeps, s: DembraneSignature): SignedBy => ({
  company: d.settings.company.name,
  name: s.name,
  role: s.role,
  day: printedDay(new Date(s.signed_at)),
});

/** Whether a signature is dembrane's, applied when the document was sent. */
export const isPresigned = (s: Pick<SignatureRow, "method">) => s.method === "presigned";

/**
 * Records dembrane's signature on a document as it is sent. Its signed copy is the document
 * as sent, which already prints the signature, so the customer's signature stamps that copy
 * and the signed PDF carries both.
 */
export async function recordDembraneSignature(
  d: AccountsDeps,
  tx: Conn,
  doc: DocumentRow,
  s: DembraneSignature,
) {
  if (!doc.fileKey || !doc.sha256) throw new Error(`document ${doc.id} has no PDF to sign`);
  const user = await store.identityByEmail(tx, s.email);
  const company = d.settings.company.name;
  const role = s.role ? `, ${s.role}` : "";
  const ref = doc.reference ? ` (${doc.reference})` : "";
  await store.insertSignature(tx, {
    id: newId(),
    slot: "dembrane",
    documentId: doc.id,
    orgId: doc.orgId,
    documentVersion: doc.version,
    signerUserId: user?.id ?? null,
    typedName: s.name,
    typedRole: s.role,
    email: s.email,
    organisation: company,
    address: null,
    vatNumber: null,
    dpaAuthorised: false,
    sha256: doc.sha256,
    fieldValues: {},
    method: "presigned",
    imageKey: null,
    imageSha256: null,
    initialsImageKey: null,
    signedAt: new Date(s.signed_at),
    ip: null,
    userAgent: null,
    confirmationText: `${s.name}${role}, signed "${doc.title}"${ref} for ${company} when it was sent, SHA-256 ${doc.sha256}.`,
    signedPdfKey: doc.fileKey,
    signedPdfSha256: doc.sha256,
    language: doc.language === "nl" ? "nl" : "en",
  });
}
