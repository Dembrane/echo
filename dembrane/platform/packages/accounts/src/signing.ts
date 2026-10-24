import { ConflictError, ForbiddenError, newId, ValidationError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { assertMaySign, documentFor } from "./access";
import type { AccountsDeps, Conn } from "./deps";
import { sha256Hex, storeRendered, writeFields } from "./documents";
import { billingPayload, documentPayload, emit, orgPayload, signaturePayload } from "./events";
import { joinOnSigning } from "./invite";
import { requestInvoices } from "./invoice";
import type { FieldKind, OfferContent } from "./offer";
import { chosenOptions, optionsOf, signedTotals } from "./options";
import { type AuditRecord, signedPdf, textPdf } from "./pdf";
import { dembraneSignature, isPresigned, recordDembraneSignature, signedBy } from "./presign";
import { emailSignedCopy } from "./signed-copy";
import { awaitingSlots, customerSlot, fieldsOf, type Slot } from "./signers";
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

/**
 * Reads the signer's name, role, organisation, address, VAT number and the PO or reference
 * they confirmed from the fields.
 */
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
    poNumber: value((f) => f.kind === "text" && f.key === "po_number"),
  };
}

/**
 * A date as a signer's page or an API client writes it, day-month-year ("28-09-2026", as
 * the documents print it) or ISO ("2026-09-28"), as an ISO date; null when it is not a day
 * on the calendar (31-02-2026, "asdf").
 */
export function isoOfDocumentDate(text: string): string | null {
  const t = text.trim();
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const [day, month, year] = dmy
    ? [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
    : ymd
      ? [Number(ymd[3]), Number(ymd[2]), Number(ymd[1])]
      : [0, 0, 0];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (
    !year ||
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day
  )
    return null;
  return at.toISOString().slice(0, 10);
}

/** The values with every date written the way the documents print it: day-month-year. */
export function printedDates(
  fields: readonly FieldRow[],
  values: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { ...values };
  for (const f of fields) {
    const v = out[f.id];
    const iso = f.kind === "date" && typeof v === "string" ? isoOfDocumentDate(v) : null;
    if (iso) out[f.id] = `${iso.slice(8)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  }
  return out;
}

/**
 * The signer writes their own calendar day: it may already be tomorrow here (time zones run
 * 14 hours ahead of UTC) or still be the day before the send (12 hours behind).
 */
const AHEAD_MS = 14 * 60 * 60 * 1000;
const BEHIND_MS = 12 * 60 * 60 * 1000;

/** When a signing date may fall: from the day the document was sent to the signer's today. */
export interface DateWindow {
  readonly now: Date;
  readonly sentAt: Date | null;
}

/**
 * Every required field filled, no values for fields the document does not have, and every
 * date a real day between the day the document was sent and today. The date is what the
 * signer writes into the agreement, so it is held to the same standard as the rest of the
 * record.
 */
export function checkValues(
  fields: readonly FieldRow[],
  values: Readonly<Record<string, string | boolean>>,
  window?: DateWindow,
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
    if (f.kind === "date" && typeof v === "string" && v.trim()) {
      const day = isoOfDocumentDate(v);
      const latest = window ? new Date(window.now.getTime() + AHEAD_MS) : null;
      const earliest = window?.sentAt
        ? new Date(window.sentAt.getTime() - BEHIND_MS).toISOString().slice(0, 10)
        : null;
      if (
        !day ||
        (latest && day > latest.toISOString().slice(0, 10)) ||
        (earliest && day < earliest)
      )
        throw new ValidationError("document.field_date_invalid", { params: { label: f.label } });
    }
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
  const { doc, org } = access;
  if (!access.email) throw new ForbiddenError("document.verified_email_required");
  // Which signature this is: the customer's, or on an offer that asks for one, their second
  // signatory's once the first is in. dembrane's counter-signature is signed by staff.
  const content = doc.kind === "offer" ? (doc.content as OfferContent | null) : null;
  const before = await store.signaturesOf(d.db, doc.id);
  const slot = customerSlot(awaitingSlots(content, before));
  if (slot === "customer") assertMaySign(access);
  if (!doc.requiresSignature) throw new ConflictError("document.no_signature_needed");
  if (doc.status === "signed") throw new ConflictError("document.already_signed");
  if (doc.status === "declined") throw new ConflictError("document.declined");
  if (doc.status === "void") throw new ConflictError("document.withdrawn");
  if (!slot) throw new ConflictError("document.signed_awaiting");
  if (slot === "second") {
    const first = before.find((x) => x.slot === "customer");
    const named = content?.second_signer?.kind === "customer" ? content.second_signer.email : null;
    if (first?.email.toLowerCase() === access.email)
      throw new ForbiddenError("document.second_signer_same");
    if (named && named.toLowerCase() !== access.email)
      throw new ForbiddenError("document.second_signer_only", { params: { email: named } });
  }
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
  // An offer whose DPA is its own document asks nothing about data processing: its signer
  // is recorded as not having agreed to it, and the DPA task stands on its own.
  const dpaSeparate =
    doc.kind === "offer" && Boolean((doc.content as OfferContent | null)?.dpa_separate);
  const dpaAuthorised = dpaSeparate ? false : input.dpa_authorised;
  const allFields = await store.fields(d.db, doc.id);
  const fields = fieldsOf(allFields, slot);
  checkValues(fields, input.values, { now, sentAt: doc.sentAt });
  // Stamped and kept the way the documents print dates, whichever form the page sent.
  const values = printedDates(fields, input.values);
  const facts = signerFacts(fields, values, org.name);
  // An offer with options: what the signer ticked is their choice, and the totals follow it.
  const choice = content && slot === "customer" ? choiceOf(content, fields, values) : null;
  const identity = await store.identity(d.db, who.directusUserId);
  const name = facts.name ?? identity?.name ?? access.email;
  // With no organisation field, the signature is for the organisation the document is in.
  const expected = confirmationText(doc, {
    name,
    role: facts.role ?? "",
    organisation: facts.organisation,
    dpa_authorised: dpaAuthorised,
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
  const language = doc.language === "nl" ? "nl" : "en";
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
    dpaAuthorised: dpaSeparate ? null : dpaAuthorised,
    signedAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
    confirmationText: expected,
    signatureId,
    method: input.signature.method,
    imageSha256,
    language,
    legal: (
      [
        ["terms", terms],
        ["sla", sla],
        ["dpa", dpa],
      ] as const
    ).flatMap(([kind, row]) =>
      row && !(kind === "sla" && (doc.content as OfferContent | null)?.template === "event")
        ? [{ kind, version: row.version, effectiveOn: row.effectiveOn, sha256: row.sha256 }]
        : [],
    ),
    trail: await auditTrail(d, doc, access.email, signedAt),
    ...(choice && { choices: choice.record }),
  };
  // A second signature stamps the copy the first one made, so the signed PDF carries both.
  const last = before.at(-1);
  const lastFile = last ? await d.files.get(last.signedPdfKey) : null;
  const base = lastFile ? new Uint8Array(await lastFile.arrayBuffer()) : unsigned;
  let pdf: Uint8Array;
  try {
    pdf = await signedPdf(
      base,
      fields.map((f) => ({ ...f, kind: f.kind as FieldKind })),
      values,
      { signature: signaturePng, initials: initialsPng },
      audit,
    );
  } catch (err) {
    // pdf-lib refuses a PNG it cannot decode; that is the signer's image, not our fault.
    if (/png/i.test((err as Error).message))
      throw new ValidationError("document.signature_unreadable");
    throw err;
  }
  const folder = `accounts/${org.id}/documents/${doc.id}`;
  const imageKey = `${folder}/signature-${signatureId}.png`;
  const initialsKey = initialsPng ? `${folder}/initials-${signatureId}.png` : null;
  const pdfKey = `${folder}/signed-${signatureId}.pdf`;
  await d.files.put(imageKey, signaturePng, "image/png");
  if (initialsKey && initialsPng) await d.files.put(initialsKey, initialsPng, "image/png");
  await d.files.put(pdfKey, pdf, "application/pdf");

  try {
    await d.db.transaction(async (tx) => {
      await store.lockOrg(tx, org.id);
      const locked = await store.documentForUpdate(tx, org.id, doc.id);
      if (!locked || !["sent", "viewed"].includes(locked.status))
        throw new ConflictError("document.already_signed");
      // Another signature made meanwhile changes whose this one is: sign again.
      const now2 = await store.signaturesOf(tx, doc.id);
      if (now2.length !== before.length) throw new ConflictError("document.changed");
      await store.insertSignature(tx, {
        slot,
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
        dpaAuthorised,
        sha256: doc.sha256 as string,
        fieldValues: values,
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
        language,
      });
      if (access.via === "signer")
        await joinOnSigning(
          tx,
          org.id,
          { directusUserId: who.directusUserId, email: access.email as string },
          now,
        );
      const awaiting = awaitingSlots(content, await store.signaturesOf(tx, doc.id));
      if (awaiting.length) {
        await signatureAdded(d, tx, org, doc, {
          actor: { kind: "customer", userId: who.directusUserId },
          slot,
          name,
          email: access.email as string,
          awaiting,
        });
        return;
      }
      await allSigned(d, tx, org, doc, {
        actor: { kind: "customer", userId: who.directusUserId },
        signerName: name,
        signerEmail: access.email as string,
        signedAt,
        pdf: { key: pdfKey, sha256: sha256Hex(pdf), bytes: pdf.byteLength },
        detail: { signer: access.email, via: access.via },
        slack: (total) =>
          `:black_nib: ${name} (${access.email}) signed "${doc.title}" for ${org.name}${total}.`,
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

/** Who did it, as the timeline records it. */
type Actor = { readonly kind: "customer" | "staff"; readonly userId: string | null };

/**
 * One signature of several is in: the timeline and Slack say whose, and which are still to
 * come. Nothing else moves until the last one: the document stays sent.
 */
export async function signatureAdded(
  d: AccountsDeps,
  tx: Conn,
  org: OrgRow,
  doc: DocumentRow,
  s: { actor: Actor; slot: Slot; name: string; email: string; awaiting: readonly Slot[] },
) {
  await emit(d, tx, {
    orgId: org.id,
    actor: s.actor,
    type: "document.signature_added",
    subject: { type: "document", id: doc.id },
    detail: { title: doc.title, slot: s.slot, signer: s.email, awaiting: s.awaiting },
    slack: `:black_nib: ${s.name} (${s.email}) signed "${doc.title}" for ${org.name}; waiting for ${s.awaiting.map((x) => (x === "dembrane" ? "dembrane's counter-signature" : "the second signatory")).join(" and ")}.`,
  });
}

/**
 * The last signature a document asked for is in: it is signed, with every effect a signature
 * had (tasks, the customer stage, the DPA), the choice made at signing counted, the signed
 * copy emailed, sam and Slack told, and the invoice asked for when it can be.
 */
export async function allSigned(
  d: AccountsDeps,
  tx: Conn,
  org: OrgRow,
  doc: DocumentRow,
  s: {
    actor: Actor;
    signerName: string;
    signerEmail: string;
    signedAt: string;
    pdf: { key: string; sha256: string; bytes: number };
    detail: Record<string, unknown>;
    slack: (total: string) => string;
  },
) {
  const now = new Date(s.signedAt);
  const content = doc.kind === "offer" ? (doc.content as OfferContent | null) : null;
  const sig = (await store.signatureOf(tx, doc.id)) as SignatureRow;
  const all = await store.signaturesOf(tx, doc.id);
  // The choice is the customer's, in the ticks of their signature.
  const fields = await store.fields(tx, doc.id);
  const choice = content
    ? choiceOf(content, fields, sig.fieldValues as Record<string, string | boolean>)
    : null;
  await store.updateDocument(tx, doc.id, {
    status: "signed",
    signedAt: now,
    updatedAt: now,
    ...choice?.columns,
  });
  await afterSigned(d, tx, org, doc, sig.dpaAuthorised, s.actor.userId);
  const fresh = (await store.document(tx, org.id, doc.id)) as DocumentRow;
  // Read again: signing an offer makes a prospect a customer.
  const signedFor = (await store.org(tx, org.id)) as OrgRow;
  // The signer and the people who run the account hold the signed copy and its details.
  const copySentTo = await emailSignedCopy(d, tx, signedFor, doc, {
    signerName: s.signerName,
    signerEmail: s.signerEmail,
    signedAt: s.signedAt,
    pdfKey: s.pdf.key,
    pdfSha256: s.pdf.sha256,
    pdfBytes: s.pdf.bytes,
  });
  const path = `${staffBase(org.id)}/documents/${doc.id}/signed.pdf`;
  const total =
    fresh.totalCents !== null
      ? `, ${(fresh.totalCents / 100).toFixed(2)} ${doc.currency ?? ""} incl. VAT`
      : "";
  await emit(d, tx, {
    orgId: org.id,
    actor: s.actor,
    type: "document.signed",
    subject: { type: "document", id: doc.id },
    detail: { title: doc.title, ...s.detail, copy_sent_to: copySentTo },
    webhook: {
      event: "account.document.signed",
      org: orgPayload(signedFor),
      document: documentPayload(fresh),
      // The customer's signature, as always; every signature when there are more.
      signature: signaturePayload(sig, path),
      signatures: all.map((x) => signaturePayload(x, path)),
      billing: billingPayload(await store.billing(tx, org.id)),
    },
    slack: s.slack(
      `${total}${choice?.chosen.length ? `, choosing ${choice.chosen.join(", ")}` : ""}`,
    ),
  });
  // An offer or a DPA can be the last thing the invoice waited for: a returning
  // customer's billing details are on file, and a DPA is often signed after the offer.
  if (doc.kind === "offer" || doc.kind === "dpa") await requestInvoices(d, tx, signedFor);
}

/**
 * The choice an offer with options was signed with: the options ticked, a line per option for
 * the signature record, and the document's lines and totals as signed. Null without options.
 */
export function choiceOf(
  content: OfferContent,
  fields: readonly { readonly id: string; readonly key: string | null }[],
  values: Readonly<Record<string, string | boolean>>,
) {
  const options = optionsOf(content.items);
  if (!options.length) return null;
  const chosen = chosenOptions(content.items, content.choose, fields, values);
  return {
    chosen,
    record: options.map((o) => ({ label: o.label, chosen: chosen.includes(o.label) })),
    columns: signedTotals(content.items, chosen),
  };
}

/**
 * The document's trail as the signature record prints it: who at dembrane sent it, when it
 * was first opened and by whom, any signer named in between, and this signature. A dispute
 * then reads from the signed PDF alone, without our database.
 */
export async function auditTrail(
  d: AccountsDeps,
  doc: DocumentRow,
  signer: string,
  signedAt: string,
  /** The last line, when it is not a signature made here. */
  last = `Signed by ${signer}`,
): Promise<{ at: string; what: string }[]> {
  const rows = await store.documentEvents(d.db, doc.orgId, doc.id);
  const ids = [...new Set(rows.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])))];
  const names = await store.userNames(d.db, ids);
  const emails = new Map(
    await Promise.all(
      ids.map(async (id) => [id, (await store.identity(d.db, id))?.email ?? null] as const),
    ),
  );
  const who = (e: (typeof rows)[number]) => {
    if (!e.actorUserId) return e.actorKind === "customer" ? "the customer" : "dembrane";
    const name = names.get(e.actorUserId);
    const email = emails.get(e.actorUserId);
    return name && email ? `${name} (${email})` : (email ?? name ?? "an unknown user");
  };
  const at = (e: (typeof rows)[number]) => new Date(e.createdAt).toISOString();
  const trail: { at: string; what: string }[] = [];
  let opened = false;
  for (const e of rows) {
    const detail = (e.detail ?? {}) as { email?: string; name?: string };
    const named = detail.name ? `${detail.name} (${detail.email})` : (detail.email ?? "");
    if (e.type === "document.sent")
      trail.push({
        at: at(e),
        what: e.actorKind === "staff" ? `Sent by ${who(e)}, dembrane` : `Sent by ${who(e)}`,
      });
    else if (e.type === "document.viewed" && !opened) {
      opened = true;
      trail.push({ at: at(e), what: `First opened by ${who(e)}` });
    } else if (e.type === "document.signer_named")
      trail.push({ at: at(e), what: `${named} named as signer by ${who(e)}` });
    else if (e.type === "document.signer_replaced")
      trail.push({ at: at(e), what: `Signer changed to ${named} by ${who(e)}` });
  }
  // dembrane's signature, applied when the document was sent, in its place in time.
  for (const s of await store.signaturesOf(d.db, doc.id))
    if (isPresigned(s))
      trail.push({
        at: s.signedAt.toISOString(),
        what: `Signed for ${s.organisation} by ${s.typedName}${s.typedRole ? `, ${s.typedRole}` : ""} (${s.email}), signed electronically when sent`,
      });
  trail.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  trail.push({ at: signedAt, what: last });
  return trail;
}

/**
 * What signing sets in motion, and an acceptance recorded outside dembrane the same: the sign
 * task is done, locked tasks open, a prospect becomes a customer, and the DPA follows.
 */
export async function afterSigned(
  d: AccountsDeps,
  tx: Conn,
  org: OrgRow,
  doc: DocumentRow,
  dpaAuthorised: boolean,
  actorId: string | null,
) {
  const tasks = await store.tasks(tx, org.id);
  // Signed without saying who signs first: the signer answered it by signing.
  for (const t of tasks)
    if (
      (t.kind === "sign" || t.code === "who_signs") &&
      t.documentId === doc.id &&
      !["done", "withdrawn"].includes(t.status)
    )
      await settleTask(d, tx, t.id, "done");
  // An offer another party pays for, or one of no charge, leaves the customer's billing
  // details task locked: no invoice needs it. A later offer the customer pays opens it.
  const signedContent = doc.content as OfferContent | null;
  const billsOther = Boolean(signedContent?.bill_to || signedContent?.no_charge);
  for (const t of tasks)
    if (
      t.status === "locked" &&
      (t.unlockOnDocumentId === doc.id ||
        (t.unlockOnDocumentId === null && doc.kind === "offer" && !billsOther))
    )
      await unlockTask(d, tx, t);
  if (doc.kind !== "offer") return;
  if (org.account_stage === "prospect")
    await store.updateOrg(tx, org.id, {
      account_stage: "customer",
      updated_at: d.now().toISOString(),
    });
  // Offers from before the DPA was its own document asked the signer whether they may also
  // agree to data processing; a no sends the DPA on its own to someone who may.
  if ((doc.content as OfferContent | null)?.dpa_separate || dpaAuthorised) return;
  await openDpa(d, tx, org.id, doc, actorId);
}

/**
 * The DPA as its own document, with its own "Review and sign" task, for someone who may
 * agree to data processing on behalf of the organisation (art. 3.6 of the terms). It
 * carries the DPA text the offer pinned and, with a signatory configured, dembrane's
 * signature. One per organisation and text: an offer sent again, or a second offer on the
 * same text, opens nothing new.
 */
export async function openDpa(
  d: AccountsDeps,
  tx: Conn,
  orgId: string,
  offer: DocumentRow,
  createdBy: string | null,
) {
  const dpa = await store.legalById(tx, offer.dpaTextId);
  if (!dpa) return;
  const open = (await store.documents(tx, orgId)).some(
    (x) => x.kind === "dpa" && x.dpaTextId === dpa.id && x.status !== "void",
  );
  if (open) return;
  const lang = offer.language === "nl" ? "nl" : "en";
  const id = newId();
  const now = d.now();
  const title = `${dpa.title} ${dpa.version}`;
  const signature = await dembraneSignature(d, tx, now);
  const rendered = await textPdf(title, dpa.body, {
    signing: true,
    language: lang,
    signed: signature && signedBy(d, signature),
  });
  const file = await storeRendered(d, orgId, id, rendered);
  await store.insertDocument(tx, {
    id,
    orgId,
    kind: "dpa",
    title,
    language: lang,
    reference: offer.reference ? `${offer.reference}-DPA` : null,
    body: dpa.body,
    ...file,
    requiresSignature: true,
    status: "draft",
    dpaTextId: dpa.id,
    externalRef: offer.externalRef,
    createdAt: now,
    updatedAt: now,
  });
  await writeFields(tx, id, rendered.fields);
  await store.updateDocument(tx, id, { status: "sent", sentAt: now, updatedAt: now });
  if (signature)
    await recordDembraneSignature(
      d,
      tx,
      (await store.document(tx, orgId, id)) as DocumentRow,
      signature,
    );
  await createTask(d, tx, {
    orgId,
    code: "sign_dpa",
    params: { document_title: title },
    title: null,
    kind: "sign",
    documentId: id,
    createdBy,
  });
}
