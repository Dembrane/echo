import { ConflictError, ForbiddenError, newId, ValidationError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { assertMaySign, documentFor } from "./access";
import type { AccountsDeps, Conn } from "./deps";
import { sha256Hex, storeRendered, writeFields } from "./documents";
import { billingPayload, documentPayload, emit, orgPayload, signaturePayload } from "./events";
import type { FieldKind } from "./offer";
import { type AuditRecord, signedPdf, textPdf } from "./pdf";
import { type DocumentRow, type FieldRow, type OrgRow, type SignatureRow, store } from "./storage";
import { createTask, settleTask, unlockTask } from "./tasks";
import { confirmationText, sameText, staffBase } from "./views";

export { sha256Hex };

export interface SignatureImageInput {
  readonly png_base64: string;
  readonly method: "drawn" | "typed" | "uploaded";
}

export interface SignInput {
  /** The sha256 of the unsigned PDF, as the signer's page received it. */
  readonly sha256: string;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly signature: SignatureImageInput;
  readonly initials: SignatureImageInput | null;
  /** Offers: whether the signer may also agree to data processing. */
  readonly dpa_authorised: boolean;
  /** The confirmation sentence as shown; must match what the server builds. */
  readonly confirmation_text: string;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const MAX_SIGNATURE_BYTES = 512 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A signature image: base64 of a PNG no larger than 512 KB. */
export function pngBytes(b64: string, what: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength > MAX_SIGNATURE_BYTES)
    throw new ValidationError("document.image_too_large", { params: { what } });
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b))
    throw new ValidationError("document.image_not_png", { params: { what } });
  return bytes;
}

/** Reads the signer's name, role, organisation, address and VAT number from the fields. */
export function signerFacts(
  fields: readonly FieldRow[],
  values: Readonly<Record<string, string | boolean>>,
  fallbackOrganisation: string,
) {
  const value = (pick: (f: FieldRow) => boolean) => {
    const f = fields.find(pick);
    const v = f ? values[f.id] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return {
    name: value((f) => f.kind === "name"),
    role: value((f) => f.kind === "role"),
    organisation:
      value((f) => f.kind === "text" && f.key === "organisation") ?? fallbackOrganisation,
    address: value((f) => f.kind === "text" && f.key === "address"),
    vatNumber: value((f) => f.kind === "text" && f.key === "vat_number"),
  };
}

/** Every required field filled, no values for fields the document does not have. */
export function checkValues(
  fields: readonly FieldRow[],
  values: Readonly<Record<string, string | boolean>>,
): void {
  const ids = new Set(fields.map((f) => f.id));
  for (const key of Object.keys(values))
    if (!ids.has(key)) throw new ValidationError("document.field_unknown", { params: { key } });
  for (const f of fields) {
    if (f.kind === "signature" || f.kind === "initials") continue;
    const v = values[f.id];
    if (f.kind === "checkbox") {
      if (v !== undefined && typeof v !== "boolean")
        throw new ValidationError("document.field_tick_invalid", { params: { label: f.label } });
      if (f.required && v !== true)
        throw new ValidationError("document.field_must_tick", { params: { label: f.label } });
      continue;
    }
    if (v !== undefined && typeof v !== "string")
      throw new ValidationError("document.field_text_invalid", { params: { label: f.label } });
    if (f.required && !(typeof v === "string" && v.trim()))
      throw new ValidationError("document.field_required", { params: { label: f.label } });
  }
}

/**
 * Signs a sent document. The stored PDF must still hash to the sha256 recorded at send
 * time and to the one the signer's page presents; every required field must be filled;
 * the confirmation must be the sentence the server builds. The signature image and the
 * signed PDF (values and image stamped at the field positions, audit page appended) are
 * stored before the insert-only signature row that names them.
 */
export async function signDocument(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  input: SignInput,
  meta: RequestMeta,
) {
  const access = await documentFor(d, who, orgId, docId, "account:sign");
  assertMaySign(access);
  const { doc, org } = access;
  if (!access.email) throw new ForbiddenError("document.verified_email_required");
  if (!doc.requiresSignature) throw new ConflictError("document.no_signature_needed");
  if (doc.status === "signed") throw new ConflictError("document.already_signed");
  if (doc.status === "declined") throw new ConflictError("document.declined");
  if (doc.status === "void") throw new ConflictError("document.withdrawn");
  const now = d.now();
  if (doc.kind === "offer" && doc.validUntil && doc.validUntil < now.toISOString().slice(0, 10))
    throw new ConflictError("document.offer_expired", { params: { valid_until: doc.validUntil } });
  if (input.sha256 !== doc.sha256) throw new ConflictError("document.changed");
  const file = doc.fileKey ? await d.files.get(doc.fileKey) : null;
  const unsigned = file ? new Uint8Array(await file.arrayBuffer()) : null;
  if (!unsigned || sha256Hex(unsigned) !== doc.sha256) {
    d.logger.error(
      { document_id: doc.id, signal: "accounts.document_hash_mismatch" },
      "stored document PDF is missing or no longer matches its sha256",
    );
    throw new ConflictError("document.signing_unavailable");
  }
  if (doc.kind === "dpa" && !input.dpa_authorised)
    throw new ValidationError("document.dpa_not_authorised");
  const fields = await store.fields(d.db, doc.id);
  checkValues(fields, input.values);
  const facts = signerFacts(fields, input.values, org.name);
  const identity = await store.identity(d.db, who.directusUserId);
  const name = facts.name ?? identity?.name ?? access.email;
  // With no organisation field, the signature is for the organisation the document is in.
  const expected = confirmationText(doc, {
    name,
    role: facts.role ?? "",
    organisation: facts.organisation,
    dpa_authorised: input.dpa_authorised,
  });
  if (!sameText(expected, input.confirmation_text))
    throw new ValidationError("document.confirmation_mismatch", { params: { expected } });
  const signaturePng = pngBytes(input.signature.png_base64, "signature");
  const initialsPng = input.initials ? pngBytes(input.initials.png_base64, "initials") : null;

  const [terms, sla, dpa] = await Promise.all([
    store.legalById(d.db, doc.termsTextId),
    store.legalById(d.db, doc.slaTextId),
    store.legalById(d.db, doc.dpaTextId),
  ]);
  const signatureId = newId();
  const signedAt = now.toISOString();
  const imageSha256 = sha256Hex(signaturePng);
  const audit: AuditRecord = {
    documentTitle: doc.title,
    documentId: doc.id,
    reference: doc.reference,
    version: doc.version,
    sha256: doc.sha256 as string,
    signerName: name,
    signerRole: facts.role,
    email: access.email,
    organisation: facts.organisation,
    address: facts.address,
    vatNumber: facts.vatNumber,
    dpaAuthorised: input.dpa_authorised,
    signedAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
    confirmationText: expected,
    signatureId,
    method: input.signature.method,
    imageSha256,
    legal: (
      [
        ["terms", terms],
        ["sla", sla],
        ["dpa", dpa],
      ] as const
    ).flatMap(([kind, row]) =>
      row ? [{ kind, version: row.version, effectiveOn: row.effectiveOn, sha256: row.sha256 }] : [],
    ),
  };
  let pdf: Uint8Array;
  try {
    pdf = await signedPdf(
      unsigned,
      fields.map((f) => ({ ...f, kind: f.kind as FieldKind })),
      input.values,
      { signature: signaturePng, initials: initialsPng },
      audit,
    );
  } catch (err) {
    // pdf-lib refuses a PNG it cannot decode; that is the signer's image, not our fault.
    if (/png/i.test((err as Error).message))
      throw new ValidationError("document.signature_unreadable");
    throw err;
  }
  const base = `accounts/${org.id}/documents/${doc.id}`;
  const imageKey = `${base}/signature-${signatureId}.png`;
  const initialsKey = initialsPng ? `${base}/initials-${signatureId}.png` : null;
  const pdfKey = `${base}/signed-${signatureId}.pdf`;
  await d.files.put(imageKey, signaturePng, "image/png");
  if (initialsKey && initialsPng) await d.files.put(initialsKey, initialsPng, "image/png");
  await d.files.put(pdfKey, pdf, "application/pdf");

  try {
    await d.db.transaction(async (tx) => {
      const locked = await store.documentForUpdate(tx, org.id, doc.id);
      if (!locked || !["sent", "viewed"].includes(locked.status))
        throw new ConflictError("document.already_signed");
      await store.insertSignature(tx, {
        id: signatureId,
        documentId: doc.id,
        orgId: org.id,
        documentVersion: doc.version,
        signerUserId: who.directusUserId,
        typedName: name,
        typedRole: facts.role,
        email: access.email as string,
        organisation: facts.organisation,
        address: facts.address,
        vatNumber: facts.vatNumber,
        dpaAuthorised: input.dpa_authorised,
        sha256: doc.sha256 as string,
        fieldValues: input.values,
        method: input.signature.method,
        imageKey,
        imageSha256,
        initialsImageKey: initialsKey,
        signedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
        confirmationText: expected,
        signedPdfKey: pdfKey,
        signedPdfSha256: sha256Hex(pdf),
      });
      await store.updateDocument(tx, doc.id, { status: "signed", signedAt: now, updatedAt: now });
      await afterSigned(d, tx, org, doc, input, who);
      const sig = (await store.signatureOf(tx, doc.id)) as SignatureRow;
      const fresh = (await store.document(tx, org.id, doc.id)) as DocumentRow;
      await emit(d, tx, {
        orgId: org.id,
        actor: { kind: "customer", userId: who.directusUserId },
        type: "document.signed",
        subject: { type: "document", id: doc.id },
        detail: { title: doc.title, signer: access.email, via: access.via },
        webhook: {
          event: "account.document.signed",
          org: orgPayload((await store.org(tx, org.id)) as OrgRow),
          document: documentPayload(fresh),
          signature: signaturePayload(sig, `${staffBase(org.id)}/documents/${doc.id}/signed.pdf`),
          billing: billingPayload(await store.billing(tx, org.id)),
        },
        slack: `:black_nib: ${name} (${access.email}) signed "${doc.title}" for ${org.name}${doc.totalCents !== null ? `, ${(doc.totalCents / 100).toFixed(2)} ${doc.currency ?? ""} incl. VAT` : ""}.`,
      });
    });
  } catch (err) {
    // Two signatures racing: the unique document id lets exactly one row in.
    if ((err as { code?: string }).code === "23505")
      throw new ConflictError("document.already_signed");
    throw err;
  }
  return { signature_id: signatureId, signed_at: signedAt, confirmation_text: expected };
}

/** What signing sets in motion: the sign task is done, locked tasks open, and the DPA follows. */
async function afterSigned(
  d: AccountsDeps,
  tx: Conn,
  org: OrgRow,
  doc: DocumentRow,
  input: SignInput,
  who: Signed,
) {
  const tasks = await store.tasks(tx, org.id);
  for (const t of tasks)
    if (t.kind === "sign" && t.documentId === doc.id && !["done", "withdrawn"].includes(t.status))
      await settleTask(d, tx, t.id, "done");
  for (const t of tasks)
    if (
      t.status === "locked" &&
      (t.unlockOnDocumentId === doc.id || (t.unlockOnDocumentId === null && doc.kind === "offer"))
    )
      await unlockTask(d, tx, t);
  if (doc.kind !== "offer") return;
  if (org.account_stage === "prospect")
    await store.updateOrg(tx, org.id, {
      account_stage: "customer",
      updated_at: d.now().toISOString(),
    });
  if (input.dpa_authorised) return;
  // The signer may not agree to data processing: the DPA becomes its own document for
  // someone who may (art. 3.6 of the terms), with the same DPA text the offer pinned.
  const dpa = await store.legalById(tx, doc.dpaTextId);
  if (!dpa) return;
  const lang = doc.language === "nl" ? "nl" : "en";
  const id = newId();
  const now = d.now();
  const title = `${dpa.title} ${dpa.version}`;
  const rendered = await textPdf(title, dpa.body, { signing: true, language: lang });
  const file = await storeRendered(d, org.id, id, rendered);
  await store.insertDocument(tx, {
    id,
    orgId: org.id,
    kind: "dpa",
    title,
    language: lang,
    reference: doc.reference ? `${doc.reference}-DPA` : null,
    body: dpa.body,
    ...file,
    requiresSignature: true,
    status: "draft",
    dpaTextId: dpa.id,
    externalRef: doc.externalRef,
    createdAt: now,
    updatedAt: now,
  });
  await writeFields(tx, id, rendered.fields);
  await store.updateDocument(tx, id, { status: "sent", sentAt: now, updatedAt: now });
  await createTask(d, tx, {
    orgId: org.id,
    code: "sign_dpa",
    params: { document_title: title },
    title: null,
    kind: "sign",
    documentId: id,
    createdBy: who.directusUserId,
  });
}
