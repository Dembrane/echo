import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
// Circular on purpose: org lives in the baseline file, and the foreign key callbacks run
// only after both modules have loaded.
import { org } from "./index";

// Customer accounts (docs/accounts.md): everything between dembrane and one customer
// organisation. Echo owns these rows; sam reads and writes them through the staff API.
// Money is integer cents everywhere, so no total is ever a float.

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * The published terms, SLA and DPA (dembrane.com/legal), one row per text that changed.
 * Insert-only (trigger in migration 0008): an offer pins rows by id, so a pinned text can
 * never change underneath a signature.
 */
export const legal_text = pgTable(
  "legal_text",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    /** As the page states it ("2.0", "3.0.1"). */
    version: text("version").notNull(),
    effectiveOn: date("effective_on", { mode: "string" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** SHA-256 hex of the body with all whitespace removed: layout changes are not new texts. */
    sha256: text("sha256").notNull(),
    sourceUrl: text("source_url").notNull(),
    createdAt: created(),
  },
  (t) => [
    unique("legal_text_kind_sha256_unique").on(t.kind, t.sha256),
    index("legal_text_kind_created_at_index").on(t.kind, t.createdAt),
    check("legal_text_kind_check", sql`${t.kind} in ('terms', 'sla', 'dpa')`),
  ],
);

/** When each legal page was last checked, so a push refreshes only when that is stale. */
export const legal_text_source = pgTable("legal_text_source", {
  kind: text("kind").primaryKey(),
  url: text("url").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  lastError: text("last_error"),
});

/**
 * An offer, DPA, invoice or other document. Once sent, what the customer reads is frozen
 * by a trigger (migration 0008): a change is a new document that supersedes this one.
 */
export const account_document = pgTable(
  "account_document",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    language: text("language").notNull().default("en"),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    /** Human reference: the offer id on the letterhead, the invoice number. */
    reference: text("reference"),
    /** Offer template (`subscription`, `event`); null for other documents. */
    template: text("template"),
    /** Structured offer (recipient, greeting, lines with bullets), rendered to body and PDF. */
    content: json("content"),
    /** The document's text, for screen readers and search; the PDF is what is signed. */
    body: text("body").notNull(),
    /**
     * The document as a PDF: rendered by echo for offers and text documents at push time,
     * uploaded for anything else. This is what the viewer shows and what gets signed.
     */
    fileKey: text("file_key"),
    pageCount: integer("page_count"),
    /** SHA-256 hex of the PDF as sent (of the body when there is no PDF): what a signature binds. */
    sha256: text("sha256"),
    requiresSignature: boolean("requires_signature").notNull().default(false),
    status: text("status").notNull().default("draft"),
    termsTextId: uuid("terms_text_id"),
    slaTextId: uuid("sla_text_id"),
    dpaTextId: uuid("dpa_text_id"),
    lines: json("lines"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }),
    vatCents: bigint("vat_cents", { mode: "number" }),
    totalCents: bigint("total_cents", { mode: "number" }),
    currency: text("currency"),
    validUntil: date("valid_until", { mode: "string" }),
    /** Where the deal lives outside echo (the Attio deal id), echoed in every event. */
    externalRef: text("external_ref"),
    /** Invoice mirrors: Exact's id (sam upserts on it), dates, payment state and link. */
    exactId: text("exact_id"),
    issuedOn: date("issued_on", { mode: "string" }),
    dueOn: date("due_on", { mode: "string" }),
    invoiceStatus: text("invoice_status"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentUrl: text("payment_url"),
    paymentReference: text("payment_reference"),
    /**
     * Someone other than the customer's admins, named to sign this one document. Once
     * named, only they may sign it, and signing in with a code reaches only this document.
     */
    signerEmail: text("signer_email"),
    signerName: text("signer_name"),
    signerRole: text("signer_role"),
    signerInvitedAt: timestamp("signer_invited_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("account_document_org_id_index").on(t.orgId),
    index("account_document_signer_email_index").on(t.signerEmail),
    unique("account_document_exact_id_unique").on(t.exactId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [org.id],
      name: "account_document_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.supersedesId],
      foreignColumns: [t.id],
      name: "account_document_supersedes_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.termsTextId],
      foreignColumns: [legal_text.id],
      name: "account_document_terms_text_id_foreign",
    }),
    foreignKey({
      columns: [t.slaTextId],
      foreignColumns: [legal_text.id],
      name: "account_document_sla_text_id_foreign",
    }),
    foreignKey({
      columns: [t.dpaTextId],
      foreignColumns: [legal_text.id],
      name: "account_document_dpa_text_id_foreign",
    }),
    check("account_document_kind_check", sql`${t.kind} in ('offer', 'dpa', 'invoice', 'other')`),
    check(
      "account_document_status_check",
      sql`${t.status} in ('draft', 'sent', 'viewed', 'signed', 'declined', 'void')`,
    ),
    check("account_document_language_check", sql`${t.language} in ('en', 'nl')`),
    check(
      "account_document_invoice_status_check",
      sql`${t.invoiceStatus} is null or ${t.invoiceStatus} in ('open', 'paid', 'overdue', 'void')`,
    ),
    check(
      "account_document_currency_check",
      sql`${t.currency} is null or ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * One simple electronic signature. Insert-only: a trigger refuses every update, delete and
 * truncate, so the evidence cannot be edited after the fact.
 */
export const account_signature = pgTable(
  "account_signature",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id").notNull(),
    orgId: uuid("org_id").notNull(),
    documentVersion: integer("document_version").notNull(),
    /** Better Auth user id (same as directus_users.id) of the signer. */
    signerUserId: uuid("signer_user_id").notNull(),
    /** From the document's name and role fields. */
    typedName: text("typed_name").notNull(),
    typedRole: text("typed_role"),
    email: text("email").notNull(),
    organisation: text("organisation").notNull(),
    address: text("address"),
    /** The organisation's VAT number, asked on the Dutch subscription offer. */
    vatNumber: text("vat_number"),
    /** The signer said they may also agree to data processing for the organisation. */
    dpaAuthorised: boolean("dpa_authorised").notNull(),
    sha256: text("sha256").notNull(),
    /** Every field's value as submitted, by field id. */
    fieldValues: json("field_values").notNull(),
    /** `drawn`, `typed` or `uploaded`. */
    method: text("method").notNull(),
    imageKey: text("image_key").notNull(),
    imageSha256: text("image_sha256").notNull(),
    initialsImageKey: text("initials_image_key"),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    confirmationText: text("confirmation_text").notNull(),
    signedPdfKey: text("signed_pdf_key").notNull(),
    signedPdfSha256: text("signed_pdf_sha256").notNull(),
  },
  (t) => [
    unique("account_signature_document_id_unique").on(t.documentId),
    index("account_signature_org_id_index").on(t.orgId),
    foreignKey({
      columns: [t.documentId],
      foreignColumns: [account_document.id],
      name: "account_signature_document_id_foreign",
    }),
    check("account_signature_method_check", sql`${t.method} in ('drawn', 'typed', 'uploaded')`),
  ],
);

/**
 * Where the signer fills in and signs, on the document's pages. Position and size are
 * fractions of the page from its top-left corner. Fixed once the document is sent
 * (trigger in migration 0008), so the fields signed are the fields that were shown.
 */
export const account_document_field = pgTable(
  "account_document_field",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id").notNull(),
    page: integer("page").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    width: doublePrecision("width").notNull(),
    height: doublePrecision("height").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    signerRole: text("signer_role").notNull().default("signer"),
    /** What a text field asks for (`organisation`, `address`, `vat_number`, `po_number`). */
    key: text("key"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [
    index("account_document_field_document_id_index").on(t.documentId),
    foreignKey({
      columns: [t.documentId],
      foreignColumns: [account_document.id],
      name: "account_document_field_document_id_foreign",
    }).onDelete("cascade"),
    check(
      "account_document_field_kind_check",
      sql`${t.kind} in ('signature', 'initials', 'name', 'role', 'date', 'text', 'checkbox')`,
    ),
    check(
      "account_document_field_box_check",
      sql`${t.page} >= 1 and ${t.x} between 0 and 1 and ${t.y} between 0 and 1 and ${t.width} between 0 and 1 and ${t.height} between 0 and 1`,
    ),
  ],
);

export const account_task = pgTable(
  "account_task",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    kind: text("kind").notNull().default("generic"),
    documentId: uuid("document_id"),
    /**
     * A locked task opens when this document is signed; a locked task without one opens
     * when any offer of the organisation is signed (the billing details task).
     */
    unlockOnDocumentId: uuid("unlock_on_document_id"),
    dueOn: date("due_on", { mode: "string" }),
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    responseText: text("response_text"),
    responseFileKey: text("response_file_key"),
    responseFileName: text("response_file_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    reviewNote: text("review_note"),
    /** Days between reminders for this task; null uses accounts.reminderIntervalDays. */
    reminderIntervalDays: integer("reminder_interval_days"),
    nextReminderAt: timestamp("next_reminder_at", { withTimezone: true }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    createdBy: uuid("created_by"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("account_task_org_id_index").on(t.orgId),
    // The tasks summary counts per organisation by status on every dashboard load.
    index("account_task_org_id_status_index").on(t.orgId, t.status),
    index("account_task_next_reminder_at_index").on(t.nextReminderAt),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [org.id],
      name: "account_task_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.documentId],
      foreignColumns: [account_document.id],
      name: "account_task_document_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.unlockOnDocumentId],
      foreignColumns: [account_document.id],
      name: "account_task_unlock_on_document_id_foreign",
    }).onDelete("set null"),
    check(
      "account_task_kind_check",
      sql`${t.kind} in ('sign', 'billing_details', 'upload', 'generic')`,
    ),
    check(
      "account_task_status_check",
      sql`${t.status} in ('locked', 'open', 'submitted', 'done', 'changes_requested', 'withdrawn')`,
    ),
    check(
      "account_task_reminder_interval_check",
      sql`${t.reminderIntervalDays} is null or ${t.reminderIntervalDays} between 1 and 365`,
    ),
  ],
);

export const account_ticket = pgTable(
  "account_ticket",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("waiting_on_dembrane"),
    openedBy: uuid("opened_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("account_ticket_org_id_index").on(t.orgId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [org.id],
      name: "account_ticket_org_id_foreign",
    }).onDelete("cascade"),
    check(
      "account_ticket_status_check",
      sql`${t.status} in ('open', 'waiting_on_customer', 'waiting_on_dembrane', 'closed')`,
    ),
  ],
);

export const account_ticket_message = pgTable(
  "account_ticket_message",
  {
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id").notNull(),
    authorUserId: uuid("author_user_id"),
    fromStaff: boolean("from_staff").notNull().default(false),
    body: text("body").notNull(),
    createdAt: created(),
  },
  (t) => [
    index("account_ticket_message_ticket_id_index").on(t.ticketId),
    foreignKey({
      columns: [t.ticketId],
      foreignColumns: [account_ticket.id],
      name: "account_ticket_message_ticket_id_foreign",
    }).onDelete("cascade"),
  ],
);

/** The organisation's timeline: who did what, when. Shown on the staff card. */
export const account_event = pgTable(
  "account_event",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** `customer`, `staff` or `system`. */
    actorKind: text("actor_kind").notNull(),
    actorUserId: uuid("actor_user_id"),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    detail: json("detail"),
    createdAt: created(),
  },
  (t) => [
    index("account_event_org_id_created_at_index").on(t.orgId, t.createdAt),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [org.id],
      name: "account_event_org_id_foreign",
    }).onDelete("cascade"),
  ],
);

/**
 * A synthetic demo staff asked echo to make (docs/accounts.md): the input, each step's
 * progress and output, so a retry resumes at the failed step and the status page shows
 * where it is. The research and corpus are kept for review; website text is stored only as
 * the few pages fetched, as evidence.
 */
export const account_demo = pgTable(
  "account_demo",
  {
    id: uuid("id").primaryKey(),
    /** Set by the seed step. */
    orgId: uuid("org_id"),
    status: text("status").notNull().default("queued"),
    input: json("input").notNull(),
    slug: text("slug"),
    /** Per step: status, started and finished times, error. */
    steps: json("steps").notNull(),
    /** Step outputs: pages, research, corpus, seed result, extraction outcome. */
    pages: json("pages"),
    research: json("research"),
    researchMarkdown: text("research_markdown"),
    corpus: json("corpus"),
    seed: json("seed"),
    offerDocumentId: uuid("offer_document_id"),
    /** Increases with each retry; part of the workflow id, so a retry is a new run. */
    attempt: integer("attempt").notNull().default(1),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("account_demo_created_at_index").on(t.createdAt),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [org.id],
      name: "account_demo_org_id_foreign",
    }).onDelete("set null"),
    check(
      "account_demo_status_check",
      sql`${t.status} in ('queued', 'running', 'draft', 'failed', 'published')`,
    ),
  ],
);
