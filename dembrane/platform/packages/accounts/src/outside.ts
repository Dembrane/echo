import { ConflictError, NotFoundError, newId, ValidationError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { staffOrg } from "./access";
import { documentDetail } from "./customer";
import { type AccountsDeps, isUuid } from "./deps";
import { sha256Hex } from "./documents";
import { billingPayload, documentPayload, emit, orgPayload, signaturePayload } from "./events";
import { requestInvoices } from "./invoice";
import { amsterdamDay } from "./invoice-plan";
import type { OfferContent } from "./offer";
import { optionKey, optionsOf } from "./options";
import { acceptanceLine, acceptedPdf, OUTSIDE_VIA, type OutsideVia } from "./pdf";
import { awaitingSlots } from "./signers";
import { afterSigned, auditTrail, choiceOf, signatureAdded } from "./signing";
import { type DocumentRow, type OrgRow, type SignatureRow, store } from "./storage";
import { settleTask } from "./tasks";
import { staffBase } from "./views";

/**
 * How a customer may accept outside dembrane: an offer by their own order letter or purchase
 * order, by email, or by signing it on paper; a DPA on paper or as their own agreement.
 */
const VIA_FOR: Record<"offer" | "dpa", readonly OutsideVia[]> = {
  offer: ["order_letter", "email", "paper"],
  dpa: ["paper", "own_document"],
};

export interface OutsideInput {
  readonly via: OutsideVia;
  readonly name: string;
  readonly role: string | null;
  readonly email: string;
  /** ISO day the customer accepted. */
  readonly accepted_on: string;
  readonly customer_reference: string | null;
  /** An offer with options: the names of those the customer chose. */
  readonly chosen_options?: readonly string[] | null;
  readonly evidence: { readonly name: string; readonly bytes: Uint8Array };
}

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

/**
 * The evidence as stored: a PDF (their letter, a scan, the email printed to PDF) or the email
 * itself saved as EML. Told apart by their bytes, never by the name the browser sent.
 */
export function evidenceFile(name: string, bytes: Uint8Array): { name: string; type: string } {
  if (bytes.byteLength > MAX_EVIDENCE_BYTES)
    throw new ValidationError("upload.too_large", { params: { max_mb: 10 } });
  const base =
    name
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .slice(0, 120)
      .trim() || "evidence";
  const stem = base.replace(/\.(pdf|eml)$/i, "") || "evidence";
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-")
    return { name: `${stem}.pdf`, type: "application/pdf" };
  // An email saved from a mail program: plain text that opens with its headers.
  const head = Buffer.from(bytes.subarray(0, 64 * 1024)).toString("utf8");
  const headers = head.split(/\r?\n\r?\n/, 1)[0] ?? "";
  if (
    !head.includes("\u0000") &&
    /^(from|to|subject|date|message-id|received|return-path|mime-version):/im.test(headers) &&
    /^(from|subject|date):/im.test(headers)
  )
    return { name: `${stem}.eml`, type: "message/rfc822" };
  throw new ValidationError("document.evidence_invalid");
}

/** Ahead and behind as at signing (signing.ts): the customer's day, in any time zone. */
const AHEAD_MS = 14 * 60 * 60 * 1000;
const BEHIND_MS = 12 * 60 * 60 * 1000;

/**
 * Records that the customer accepted a sent offer or DPA outside dembrane. It has every effect
 * of a signature made here: the document is signed, its sign and who-signs tasks close, a
 * prospect becomes a customer, the billing step and the DPA follow, sam and Slack are told,
 * and the invoice is asked for as the offer's plan says. The record is the signature row
 * (method `outside`, insert-only) with the evidence file and its SHA-256, the sent PDF's
 * SHA-256, and a copy of the PDF with an acceptance record page instead of a drawn signature.
 * Undone only by voiding the document with a reason (voidAcceptance).
 */
export async function acceptOutside(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  input: OutsideInput,
) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (!doc) throw new NotFoundError("document.not_found");
  assertAcceptable(doc);
  const kind = doc.kind as "offer" | "dpa";
  if (!VIA_FOR[kind].includes(input.via)) throw new ValidationError("document.outside_via_invalid");
  const now = d.now();
  const latest = amsterdamDay(new Date(now.getTime() + AHEAD_MS));
  const earliest = doc.sentAt ? amsterdamDay(new Date(doc.sentAt.getTime() - BEHIND_MS)) : null;
  if (input.accepted_on > latest || (earliest && input.accepted_on < earliest))
    throw new ValidationError("document.outside_date_invalid");
  const evidence = evidenceFile(input.evidence.name, input.evidence.bytes);
  // An offer with options: staff say what the customer chose, as ticks on its option fields,
  // so the record reads as a signature made here would.
  const content = kind === "offer" ? (doc.content as OfferContent | null) : null;
  const fields = await store.fields(d.db, doc.id);
  const ticks: Record<string, boolean> = {};
  const options = content ? optionsOf(content.items) : [];
  for (const name of input.chosen_options ?? [])
    if (!options.some((o) => o.label === name))
      throw new ValidationError("document.option_unknown", { params: { option: name } });
  for (const o of options) {
    const f = fields.find((x) => x.key === optionKey(o.number));
    if (f) ticks[f.id] = (input.chosen_options ?? []).includes(o.label);
  }
  const choice = content ? choiceOf(content, fields, ticks) : null;
  const sent = doc.fileKey ? await d.files.get(doc.fileKey) : null;
  const sentBytes = sent ? new Uint8Array(await sent.arrayBuffer()) : null;
  if (!sentBytes || sha256Hex(sentBytes) !== doc.sha256) {
    d.logger.error(
      { document_id: doc.id, signal: "accounts.document_hash_mismatch" },
      "stored document PDF is missing or no longer matches its sha256",
    );
    throw new ConflictError("document.signing_unavailable");
  }

  const id = newId();
  const recordedAt = now.toISOString();
  const staff = (await store.identity(d.db, who.directusUserId))?.email ?? "dembrane staff";
  const evidenceSha256 = sha256Hex(input.evidence.bytes);
  const reference = kind === "offer" ? input.customer_reference : null;
  const accepted = input.role ? `${input.name}, ${input.role}` : input.name;
  const ref = doc.reference ? ` (${doc.reference})` : "";
  // What the record states, in the words of the record page: kept on the row verbatim.
  const chose = choice?.chosen.length ? ` They chose ${choice.chosen.join(", ")}.` : "";
  const statement = `Recorded by ${staff}: "${doc.title}"${ref}, SHA-256 ${doc.sha256}, was accepted ${OUTSIDE_VIA[input.via]} on ${input.accepted_on} by ${accepted} (${input.email}) for ${org.name}.${chose} Evidence: ${evidence.name}, SHA-256 ${evidenceSha256}.`;
  const [terms, sla, dpa] = await Promise.all([
    store.legalById(d.db, doc.termsTextId),
    store.legalById(d.db, doc.slaTextId),
    store.legalById(d.db, doc.dpaTextId),
  ]);
  const isEvent = (doc.content as OfferContent | null)?.template === "event";
  const pdf = await acceptedPdf(sentBytes, {
    documentTitle: doc.title,
    documentId: doc.id,
    reference: doc.reference,
    version: doc.version,
    sha256: doc.sha256 as string,
    via: input.via,
    acceptedOn: input.accepted_on,
    name: input.name,
    role: input.role,
    email: input.email,
    organisation: org.name,
    customerReference: reference,
    evidence: { ...evidence, sha256: evidenceSha256, bytes: input.evidence.bytes },
    recordedBy: staff,
    recordedAt,
    acceptanceId: id,
    statement,
    ...(choice && { choices: choice.record }),
    legal: (
      [
        ["terms", terms],
        ["sla", sla],
        ["dpa", dpa],
      ] as const
    ).flatMap(([k, row]) =>
      row && !(k === "sla" && isEvent)
        ? [{ kind: k, version: row.version, effectiveOn: row.effectiveOn, sha256: row.sha256 }]
        : [],
    ),
    trail: await auditTrail(
      d,
      doc,
      input.email,
      recordedAt,
      `${acceptanceLine(input.via, input.accepted_on)} Recorded by ${staff}`,
    ),
  });
  const base = `accounts/${org.id}/documents/${doc.id}`;
  const evidenceKey = `${base}/evidence-${id}.${evidence.type === "application/pdf" ? "pdf" : "eml"}`;
  const pdfKey = `${base}/signed-${id}.pdf`;
  await d.files.put(evidenceKey, input.evidence.bytes, evidence.type);
  await d.files.put(pdfKey, pdf, "application/pdf");

  try {
    await d.db.transaction(async (tx) => {
      await store.lockOrg(tx, org.id);
      const locked = await store.documentForUpdate(tx, org.id, doc.id);
      if (!locked) throw new ConflictError("document.not_awaiting_signature");
      assertAcceptable(locked);
      await store.insertSignature(tx, {
        id,
        documentId: doc.id,
        orgId: org.id,
        documentVersion: doc.version,
        signerUserId: null,
        typedName: input.name,
        typedRole: input.role,
        email: input.email,
        organisation: org.name,
        address: null,
        vatNumber: null,
        // An acceptance outside says nothing about data processing: the DPA stands alone.
        dpaAuthorised: false,
        sha256: doc.sha256 as string,
        fieldValues: ticks,
        method: "outside",
        imageKey: null,
        imageSha256: null,
        initialsImageKey: null,
        signedAt: now,
        ip: null,
        userAgent: null,
        confirmationText: statement,
        signedPdfKey: pdfKey,
        signedPdfSha256: sha256Hex(pdf),
        language: doc.language === "nl" ? "nl" : "en",
        outsideVia: input.via,
        acceptedOn: input.accepted_on,
        evidenceKey,
        evidenceSha256,
        evidenceName: evidence.name,
        evidenceType: evidence.type,
        customerReference: reference,
        recordedBy: who.directusUserId,
      });
      // An offer that also asks for dembrane's counter-signature waits for it: the timeline
      // records the acceptance, and the counter-signature completes the offer.
      if (kind === "offer") {
        const awaiting = awaitingSlots(content, await store.signaturesOf(tx, doc.id));
        if (awaiting.length) {
          await signatureAdded(d, tx, org, doc, {
            actor: { kind: "staff", userId: who.directusUserId },
            slot: "customer",
            name: input.name,
            email: input.email,
            awaiting,
          });
          return;
        }
      }
      await store.updateDocument(tx, doc.id, {
        status: "signed",
        signedAt: now,
        updatedAt: now,
        ...choice?.columns,
      });
      await afterSigned(d, tx, org, doc, false, who.directusUserId);
      const sig = (await store.signatureOf(tx, doc.id)) as SignatureRow;
      const fresh = (await store.document(tx, org.id, doc.id)) as DocumentRow;
      // Read again: accepting an offer makes a prospect a customer.
      const acceptedFor = (await store.org(tx, org.id)) as OrgRow;
      await emit(d, tx, {
        orgId: org.id,
        actor: { kind: "staff", userId: who.directusUserId },
        // A DPA is signed, an offer accepted: the timeline says which.
        type: kind === "dpa" ? "document.signed_outside" : "document.accepted_outside",
        subject: { type: "document", id: doc.id },
        detail: {
          title: doc.title,
          via: input.via,
          accepted_on: input.accepted_on,
          accepted_by: input.email,
          evidence_sha256: evidenceSha256,
          customer_reference: reference,
        },
        // The signature's message, so sam and the deal follow as for one made here; its
        // `signature.outside` says it was accepted outside dembrane, and how.
        webhook: {
          event: "account.document.signed",
          org: orgPayload(acceptedFor),
          document: documentPayload(fresh),
          signature: signaturePayload(sig, `${staffBase(org.id)}/documents/${doc.id}/signed.pdf`),
          billing: billingPayload(await store.billing(tx, org.id)),
        },
        slack: `:inbox_tray: Accepted outside dembrane: ${accepted} (${input.email}) accepted "${doc.title}" for ${org.name} ${OUTSIDE_VIA[input.via]} on ${input.accepted_on}${reference ? `, reference ${reference}` : ""}${fresh.totalCents !== null ? `, ${(fresh.totalCents / 100).toFixed(2)} ${doc.currency ?? ""} incl. VAT` : ""}. Recorded by ${staff}, evidence attached.`,
      });
      // As after a signature: the offer or the DPA may be the last thing the invoice waited for.
      await requestInvoices(d, tx, acceptedFor);
    });
  } catch (err) {
    // A signature and an acceptance racing: the unique document id lets exactly one row in.
    if ((err as { code?: string }).code === "23505")
      throw new ConflictError("document.already_signed");
    throw err;
  }
  return documentDetail(
    d,
    (await store.document(d.db, org.id, doc.id)) as DocumentRow,
    "staff",
    who,
  );
}

/** Only a sent offer or DPA that waits for a signature can be accepted outside dembrane. */
function assertAcceptable(doc: DocumentRow) {
  if (doc.status === "signed") throw new ConflictError("document.already_signed");
  if (doc.status === "void") throw new ConflictError("document.withdrawn");
  if (doc.status === "declined") throw new ConflictError("document.declined");
  if (
    !(doc.kind === "offer" || doc.kind === "dpa") ||
    !doc.requiresSignature ||
    !["sent", "viewed"].includes(doc.status)
  )
    throw new ConflictError("document.not_awaiting_signature");
}

/**
 * Voids a document accepted outside dembrane, the one way to undo such an acceptance (the
 * wrong letter, the wrong offer). A reason is required. The acceptance row and its evidence
 * stay as the record; the document is withdrawn with its open tasks, and sam and Slack hear
 * of it. An invoice already asked for is not recalled here: sam's message says it was signed.
 */
export async function voidAcceptance(
  d: AccountsDeps,
  who: Signed,
  org: OrgRow,
  doc: DocumentRow,
  sig: SignatureRow,
  reason: string | null,
) {
  if (!reason?.trim()) throw new ValidationError("document.void_reason_required");
  const staff = (await store.identity(d.db, who.directusUserId))?.email ?? null;
  const asked = await store.eventSubjects(d.db, org.id, "invoice.requested");
  const invoiced = [...asked].some((s) => s === doc.id || s.startsWith(`${doc.id}:`));
  await d.db.transaction(async (tx) => {
    await store.lockOrg(tx, org.id);
    const locked = await store.documentForUpdate(tx, org.id, doc.id);
    if (locked?.status !== "signed") throw new ConflictError("document.not_signed");
    const now = d.now();
    await store.updateDocument(tx, doc.id, { status: "void", voidedAt: now, updatedAt: now });
    for (const t of await store.tasks(tx, org.id))
      if (t.documentId === doc.id && !["done", "withdrawn"].includes(t.status))
        await settleTask(d, tx, t.id, "withdrawn");
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "staff", userId: who.directusUserId },
      type: "document.acceptance_voided",
      subject: { type: "document", id: doc.id },
      detail: { reason, via: sig.outsideVia, invoice_requested: invoiced },
      webhook: {
        event: "account.document.voided",
        org: orgPayload(org),
        document: documentPayload(doc),
        was: "signed",
        reason,
        voided_by: staff,
        /** It was accepted outside dembrane, and how; its invoice may already be asked for. */
        accepted_outside: { via: sig.outsideVia, accepted_on: sig.acceptedOn },
        invoice_requested: invoiced,
      },
      slack: `:warning: The acceptance of "${doc.title}" for ${org.name} (${OUTSIDE_VIA[sig.outsideVia as OutsideVia] ?? "outside dembrane"}) was voided by ${staff ?? "staff"}: ${reason}.${invoiced ? " Its invoice was already asked for." : ""}`,
    });
  });
}

/** The evidence file of an acceptance outside dembrane, as staff recorded it. */
export async function staffEvidence(d: AccountsDeps, orgId: string, docId: string) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (!doc) throw new NotFoundError("document.not_found");
  const sig = await store.signatureOf(d.db, doc.id);
  const blob = sig?.evidenceKey ? await d.files.get(sig.evidenceKey) : null;
  if (!sig || !blob) throw new NotFoundError("document.no_evidence");
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    name: sig.evidenceName ?? "evidence",
    type: sig.evidenceType ?? "application/octet-stream",
  };
}
