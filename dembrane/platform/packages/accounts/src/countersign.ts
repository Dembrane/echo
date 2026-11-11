import { ConflictError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { staffOrg } from "./access";
import { documentDetail } from "./customer";
import { type AccountsDeps, isUuid } from "./deps";
import { sha256Hex } from "./documents";
import { amsterdamDay } from "./invoice-plan";
import type { FieldKind, OfferContent } from "./offer";
import { type AuditRecord, signedPdf } from "./pdf";
import { awaitingSlots, fieldsOf } from "./signers";
import {
  allSigned,
  auditTrail,
  pngBytes,
  type RequestMeta,
  type SignatureImageInput,
  signatureAdded,
} from "./signing";
import { type DocumentRow, store } from "./storage";

/**
 * dembrane's counter-signature of an offer that asks for it, by the staff member it names,
 * signed in as themselves: a staff key cannot sign for a person. It may come before or after
 * the customer's. The date is today in Amsterdam; name and role are what the offer prints.
 * Like a customer's, it stamps the copy the signatures before it made, is its own
 * insert-only row, and when it is the last one the offer is signed with every effect that
 * has.
 */
export async function countersign(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  input: { readonly signature: SignatureImageInput },
  meta: RequestMeta,
) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (!doc) throw new NotFoundError("document.not_found");
  const content = doc.kind === "offer" ? (doc.content as OfferContent | null) : null;
  const second = content?.second_signer;
  const before = await store.signaturesOf(d.db, doc.id);
  if (
    second?.kind !== "dembrane" ||
    !["sent", "viewed"].includes(doc.status) ||
    before.some((s) => s.slot === "dembrane")
  )
    throw new ConflictError("document.countersign_not_asked");
  const identity = await store.identity(d.db, who.directusUserId);
  const email = identity?.email?.toLowerCase() ?? null;
  if (who.staffPolicies || email !== second.email.toLowerCase())
    throw new ForbiddenError("document.countersign_not_you", { params: { email: second.email } });
  const file = doc.fileKey ? await d.files.get(doc.fileKey) : null;
  const unsigned = file ? new Uint8Array(await file.arrayBuffer()) : null;
  if (!unsigned || sha256Hex(unsigned) !== doc.sha256) {
    d.logger.error(
      { document_id: doc.id, signal: "accounts.document_hash_mismatch" },
      "stored document PDF is missing or no longer matches its sha256",
    );
    throw new ConflictError("document.signing_unavailable");
  }
  const now = d.now();
  const signedAt = now.toISOString();
  const day = amsterdamDay(now);
  const fields = fieldsOf(await store.fields(d.db, doc.id), "dembrane");
  const values: Record<string, string> = {};
  for (const f of fields)
    if (f.kind === "date") values[f.id] = `${day.slice(8)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
  const png = pngBytes(input.signature.png_base64, "signature");
  const company = d.settings.company.name;
  const role = second.role ? `, ${second.role}` : "";
  const ref = doc.reference ? ` (${doc.reference})` : "";
  const confirmation = `I, ${second.name}${role}, sign "${doc.title}"${ref} for ${company} as shown, SHA-256 ${doc.sha256}.`;
  const signatureId = newId();
  const language = doc.language === "nl" ? "nl" : "en";
  const imageSha256 = sha256Hex(png);
  const audit: AuditRecord = {
    documentTitle: doc.title,
    documentId: doc.id,
    reference: doc.reference,
    version: doc.version,
    sha256: doc.sha256 as string,
    signerName: second.name,
    signerRole: second.role,
    email: identity?.email as string,
    organisation: company,
    address: null,
    vatNumber: null,
    dpaAuthorised: null,
    signedAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
    confirmationText: confirmation,
    signatureId,
    method: input.signature.method,
    imageSha256,
    language,
    legal: [],
    trail: await auditTrail(
      d,
      doc,
      identity?.email as string,
      signedAt,
      `Counter-signed by ${second.name}, ${company}`,
    ),
  };
  // Stamped on the copy the signatures before it made, so the signed PDF carries all.
  const last = before.at(-1);
  const lastFile = last ? await d.files.get(last.signedPdfKey) : null;
  const base = lastFile ? new Uint8Array(await lastFile.arrayBuffer()) : unsigned;
  const pdf = await signedPdf(
    base,
    fields.map((f) => ({ ...f, kind: f.kind as FieldKind })),
    values,
    { signature: png, initials: null },
    audit,
  );
  const folder = `accounts/${org.id}/documents/${doc.id}`;
  const imageKey = `${folder}/signature-${signatureId}.png`;
  const pdfKey = `${folder}/signed-${signatureId}.pdf`;
  await d.files.put(imageKey, png, "image/png");
  await d.files.put(pdfKey, pdf, "application/pdf");

  try {
    await d.db.transaction(async (tx) => {
      await store.lockOrg(tx, org.id);
      const locked = await store.documentForUpdate(tx, org.id, doc.id);
      if (!locked || !["sent", "viewed"].includes(locked.status))
        throw new ConflictError("document.countersign_not_asked");
      if ((await store.signaturesOf(tx, doc.id)).length !== before.length)
        throw new ConflictError("document.changed");
      await store.insertSignature(tx, {
        id: signatureId,
        slot: "dembrane",
        documentId: doc.id,
        orgId: org.id,
        documentVersion: doc.version,
        signerUserId: who.directusUserId,
        typedName: second.name,
        typedRole: second.role,
        email: identity?.email as string,
        organisation: company,
        address: null,
        vatNumber: null,
        dpaAuthorised: false,
        sha256: doc.sha256 as string,
        fieldValues: values,
        method: input.signature.method,
        imageKey,
        imageSha256,
        initialsImageKey: null,
        signedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
        confirmationText: confirmation,
        signedPdfKey: pdfKey,
        signedPdfSha256: sha256Hex(pdf),
        language,
      });
      const actor = { kind: "staff" as const, userId: who.directusUserId };
      const awaiting = awaitingSlots(content, await store.signaturesOf(tx, doc.id));
      if (awaiting.length) {
        await signatureAdded(d, tx, org, doc, {
          actor,
          slot: "dembrane",
          name: second.name,
          email: identity?.email as string,
          awaiting,
        });
        return;
      }
      // The customer signed first: their copy of the signed offer goes to them.
      const customer = await store.signatureOf(tx, doc.id);
      await allSigned(d, tx, org, doc, {
        actor,
        signerName: customer?.typedName ?? second.name,
        signerEmail: customer?.email ?? (identity?.email as string),
        signedAt,
        pdf: { key: pdfKey, sha256: sha256Hex(pdf), bytes: pdf.byteLength },
        detail: { signer: identity?.email, via: "countersign" },
        slack: (total) =>
          `:black_nib: ${second.name} counter-signed "${doc.title}" for ${company}; ${org.name} signed it before${total}.`,
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505")
      throw new ConflictError("document.countersign_not_asked");
    throw err;
  }
  return documentDetail(
    d,
    (await store.document(d.db, org.id, doc.id)) as DocumentRow,
    "staff",
    who,
  );
}
