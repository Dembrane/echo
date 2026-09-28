import type { Company } from "./deps";
import type { Language } from "./offer";
import type {
  BillingRow,
  DocumentRow,
  EventRow,
  FieldRow,
  LegalRow,
  MessageRow,
  SignatureRow,
  TaskRow,
  TicketRow,
} from "./storage";

/** Response shapes: snake_case JSON, ISO timestamps, integer cents. */

const iso = (d: Date | string | null | undefined) =>
  d ? (d instanceof Date ? d : new Date(d)).toISOString() : null;

/** Bank transfer details: always on an invoice; the Mollie link only when there is one. */
export function paymentView(doc: DocumentRow, company: Company) {
  return {
    bank_transfer: {
      iban: company.iban,
      bic: company.bic,
      account_name: company.accountName,
      reference: doc.paymentReference ?? doc.reference,
    },
    payment_url: doc.paymentUrl,
  };
}

/**
 * Where a document's files are served: the customer's account path or the staff path.
 * Relative on purpose: the dashboard reaches /api through its same-origin proxy, so the
 * browser sends the session cookie and no CORS rule is involved.
 */
export const customerBase = (orgId: string) => `/api/v2/orgs/${orgId}/account`;
export const staffBase = (orgId: string) => `/api/v2/admin/accounts/${orgId}`;

export function documentSummary(
  doc: DocumentRow,
  sig: SignatureRow | null,
  company: Company,
  base: string,
) {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    reference: doc.reference,
    language: doc.language,
    version: doc.version,
    status: doc.status,
    requires_signature: doc.requiresSignature,
    currency: doc.currency,
    subtotal_cents: doc.subtotalCents,
    vat_cents: doc.vatCents,
    total_cents: doc.totalCents,
    valid_until: doc.validUntil,
    sent_at: iso(doc.sentAt),
    viewed_at: iso(doc.viewedAt),
    signed_at: iso(doc.signedAt),
    declined_at: iso(doc.declinedAt),
    voided_at: iso(doc.voidedAt),
    signer: doc.signerEmail
      ? { email: doc.signerEmail, name: doc.signerName, role: doc.signerRole }
      : null,
    file_url: doc.fileKey ? `${base}/documents/${doc.id}/file` : null,
    signed_pdf_url: sig ? `${base}/documents/${doc.id}/signed.pdf` : null,
    ...(doc.kind === "invoice" && {
      invoice: {
        number: doc.reference,
        exact_id: doc.exactId,
        issued_on: doc.issuedOn,
        due_on: doc.dueOn,
        status: doc.invoiceStatus,
        paid_at: iso(doc.paidAt),
        ...paymentView(doc, company),
      },
    }),
  };
}

const NOTE: Record<Language, { offer: string; dpa: string; other: string }> = {
  en: {
    offer:
      "Signing makes the agreement complete, so we can invoice and your terms, SLA and data processing are in force.",
    dpa: "Signing puts the data processing agreement in force, which completes the agreement.",
    other: "Signing records that you agree to this document.",
  },
  nl: {
    offer:
      "Met je handtekening is de overeenkomst compleet: wij kunnen factureren, en je voorwaarden, SLA en verwerkersovereenkomst gelden.",
    dpa: "Met je handtekening geldt de verwerkersovereenkomst, en is de overeenkomst compleet.",
    other: "Met je handtekening leg je vast dat je akkoord gaat met dit document.",
  },
};

export function signingNote(doc: DocumentRow): string {
  const lang = (doc.language === "nl" ? "nl" : "en") as Language;
  return NOTE[lang][doc.kind === "offer" ? "offer" : doc.kind === "dpa" ? "dpa" : "other"];
}

export interface ConfirmationFields {
  readonly name: string;
  readonly role: string;
  readonly organisation: string;
  readonly dpa_authorised: boolean;
}

/**
 * The sentence the signer confirms, stored verbatim on the signature. The page shows the
 * template with the typed values filled in; the server builds the same sentence and
 * refuses a signature whose text differs, so what is stored is what was shown.
 */
export function confirmationText(doc: DocumentRow, f: ConfirmationFields): string {
  const ref = doc.reference ? ` (${doc.reference})` : "";
  const nl = doc.language === "nl";
  const who = f.role ? `${f.name}, ${f.role}` : f.name;
  const base = nl
    ? `Ik, ${who}, bevestig dat ik namens ${f.organisation} mag tekenen, en ik onderteken "${doc.title}"${ref} zoals aan mij getoond, SHA-256 ${doc.sha256}.`
    : `I, ${who}, confirm that I may sign on behalf of ${f.organisation}, and I sign "${doc.title}"${ref} as shown to me, SHA-256 ${doc.sha256}.`;
  if (doc.kind !== "offer") return base;
  const dpa = f.dpa_authorised
    ? nl
      ? " Ik ben ook bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan."
      : " I am also authorised to agree to data processing on behalf of this organisation."
    : nl
      ? " Ik ben niet bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan; de verwerkersovereenkomst wordt apart ondertekend."
      : " I am not authorised to agree to data processing on behalf of this organisation; the data processing agreement will be signed separately.";
  return base + dpa;
}

export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export function legalView(kind: string, row: LegalRow | null) {
  return row
    ? {
        kind,
        version: row.version,
        effective_on: row.effectiveOn,
        url: row.sourceUrl,
        sha256: row.sha256,
      }
    : null;
}

export function signatureView(s: SignatureRow) {
  return {
    id: s.id,
    name: s.typedName,
    role: s.typedRole ?? "",
    email: s.email,
    organisation: s.organisation,
    address: s.address,
    vat_number: s.vatNumber,
    dpa_authorised: s.dpaAuthorised,
    signed_at: iso(s.signedAt),
    sha256: s.sha256,
    method: s.method as "drawn" | "typed" | "uploaded",
    image_sha256: s.imageSha256,
    values: (s.fieldValues ?? {}) as Record<string, string | boolean>,
  };
}

export function fieldView(f: FieldRow) {
  return {
    id: f.id,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    kind: f.kind as "signature" | "initials" | "name" | "role" | "date" | "text" | "checkbox",
    label: f.label,
    required: f.required,
    signer_role: "signer" as const,
    key: f.key,
    sort: f.sort,
  };
}

/**
 * What a locked task waits for: its own document, or, for the billing details task that
 * opens on the first signed offer, the newest offer waiting for a signature.
 */
function lockedUntil(t: TaskRow, docs: readonly DocumentRow[]) {
  if (t.status !== "locked") return null;
  if (t.unlockOnDocumentId) return docs.find((x) => x.id === t.unlockOnDocumentId) ?? null;
  return (
    docs
      .filter((x) => x.kind === "offer" && ["sent", "viewed"].includes(x.status))
      .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0] ?? null
  );
}

/** A task as the API returns it; `docs` are the organisation's documents, for lock titles. */
export function taskView(t: TaskRow, docs: readonly DocumentRow[] = []) {
  const waitsFor = lockedUntil(t, docs);
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    kind: t.kind,
    status: t.status,
    /** Greyed out on the page until the document it waits for is signed. */
    locked: t.status === "locked",
    locked_until_document_id: waitsFor?.id ?? null,
    locked_until_title: waitsFor?.title ?? null,
    document_id: t.documentId,
    due_on: t.dueOn,
    opened_at: iso(t.openedAt),
    response_text: t.responseText,
    response_file_name: t.responseFileName,
    submitted_at: iso(t.submittedAt),
    review_note: t.reviewNote,
    reviewed_at: iso(t.reviewedAt),
    next_reminder_at: iso(t.nextReminderAt),
    reminder_interval_days: t.reminderIntervalDays,
    reminders_sent: t.remindersSent,
  };
}

export function ticketView(t: TicketRow, messages: readonly MessageRow[]) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
    closed_at: iso(t.closedAt),
    messages: messages
      .filter((m) => m.ticketId === t.id)
      .map((m) => ({
        id: m.id,
        body: m.body,
        from: m.fromStaff ? "dembrane" : "customer",
        created_at: iso(m.createdAt),
      })),
  };
}

export function billingView(b: BillingRow | null) {
  return {
    legal_name: b?.billing_legal_name ?? null,
    vat_id: b?.billing_vat_id ?? null,
    kvk_number: b?.kvk_number ?? null,
    kbo_number: b?.kbo_number ?? null,
    billing_email: b?.billing_email ?? null,
    po_number: b?.po_number ?? null,
    peppol_id: b?.peppol_id ?? null,
    address_line1: b?.billing_address_line1 ?? null,
    address_line2: b?.billing_address_line2 ?? null,
    postal_code: b?.billing_postal_code ?? null,
    city: b?.billing_city ?? null,
    country: b?.billing_country ?? null,
  };
}

export function eventView(e: EventRow) {
  return {
    id: e.id,
    type: e.type,
    actor: e.actorKind,
    actor_user_id: e.actorUserId,
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    detail: e.detail,
    created_at: iso(e.createdAt),
  };
}
