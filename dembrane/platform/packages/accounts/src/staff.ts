import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  newId,
  ValidationError,
} from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { and, eq, gt, isNull } from "drizzle-orm";
import { staffOrg } from "./access";
import { documentDetail, fileBytes, signedBytes, ticketOf } from "./customer";
import { type AccountsDeps, type Conn, isUuid } from "./deps";
import { fieldProblems, sha256Hex, storePdf, storeRendered, writeFields } from "./documents";
import { emit } from "./events";
import { legalForPush } from "./legal/store";
import {
  type Language,
  type OfferContent,
  type OfferItem,
  type OfferTemplate,
  offerText,
  offerTotals,
  validUntil,
} from "./offer";
import { offerPdf, type PlacedField, pageCountOf, textPdf } from "./pdf";
import { type DocumentRow, type LegalRow, store } from "./storage";
import { createTask, ensureBillingTask, settleTask, type TaskKind } from "./tasks";
import {
  billingView,
  documentSummary,
  eventView,
  fieldView,
  staffBase,
  taskView,
  ticketView,
} from "./views";

type Actor = { kind: "staff"; userId: string };
const actorOf = (who: Signed): Actor => ({ kind: "staff", userId: who.directusUserId });

export async function listAccounts(
  d: AccountsDeps,
  q: { stage: string | null; q: string | null; limit: number; offset: number },
) {
  const rows = await store.accountList(d.db, q);
  return {
    accounts: rows.map((r) => ({
      ...r,
      stage: r.stage as "prospect" | "customer" | "churned" | null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
    limit: q.limit,
    offset: q.offset,
  };
}

/** The organisation card: everything staff and sam need about one account. */
export async function accountCard(d: AccountsDeps, orgId: string) {
  const org = await staffOrg(d, orgId);
  const [docs, sigs, tasks, tickets, billing, members, usage, events] = await Promise.all([
    store.documents(d.db, org.id),
    store.signatures(d.db, org.id),
    store.tasks(d.db, org.id),
    store.tickets(d.db, org.id),
    store.billing(d.db, org.id),
    store.members(d.db, org.id),
    store.usage(d.db, org.id),
    store.events(d.db, org.id, 200),
  ]);
  const messages = await store.messages(
    d.db,
    tickets.map((t) => t.id),
  );
  const pricing = org.origin_pricing_configuration_id
    ? await store.pricingById(d.db, org.origin_pricing_configuration_id)
    : null;
  const manager = billing?.account_manager_id
    ? await store.appUser(d.db, billing.account_manager_id)
    : null;
  const invites = await d.db
    .select({
      email: schema.org_invite.email,
      role: schema.org_invite.role,
      expires_at: schema.org_invite.expires_at,
    })
    .from(schema.org_invite)
    .where(
      and(
        eq(schema.org_invite.org_id, org.id),
        isNull(schema.org_invite.accepted_at),
        isNull(schema.org_invite.deleted_at),
        gt(schema.org_invite.expires_at, d.now().toISOString()),
      ),
    );
  const demo = events.find((e) => e.type === "demo.seeded");
  return {
    organisation: {
      id: org.id,
      name: org.name,
      account_stage: org.account_stage as "prospect" | "customer" | "churned" | null,
      created_at: org.created_at ? new Date(org.created_at).toISOString() : null,
    },
    account_manager: manager
      ? { id: manager.id, email: manager.email, name: manager.display_name }
      : null,
    billing: billingView(billing),
    needs_form: pricing
      ? {
          id: pricing.id,
          reference: pricing.reference,
          status: pricing.status,
          email: pricing.email,
          answers: pricing.answers_raw,
          config: pricing.config,
          booking_status: pricing.booking_status,
          booking_uid: pricing.booking_uid,
        }
      : null,
    demo: demo ? demo.detail : null,
    members: members.map((m) => ({
      app_user_id: m.appUserId,
      email: m.email,
      name: m.name,
      role: m.role,
      since: m.since ? new Date(m.since).toISOString() : null,
    })),
    pending_invites: invites.map((i) => ({
      ...i,
      expires_at: new Date(i.expires_at).toISOString(),
    })),
    usage,
    documents: docs.map((x) =>
      documentSummary(
        x,
        sigs.find((s) => s.documentId === x.id) ?? null,
        d.settings.company,
        staffBase(org.id),
      ),
    ),
    tasks: tasks.map((t) => taskView(t, docs)),
    tickets: tickets.map((t) => ticketView(t, messages)),
    timeline: events.map(eventView),
  };
}

/**
 * The account side for any organisation (a free-tier signup, a customer who never had a
 * demo): its stage, its own billing account, and the billing details task, so offers and
 * tasks can be pushed to it like to any prospect.
 */
export async function enableAccount(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: { stage: "prospect" | "customer" | "churned"; language: Language },
) {
  const org = await staffOrg(d, orgId);
  const nowIso = d.now().toISOString();
  await d.db.transaction(async (tx) => {
    await store.updateOrg(tx, org.id, { account_stage: input.stage, updated_at: nowIso });
    if (!(await store.billing(tx, org.id)))
      await store.insertBilling(tx, {
        id: newId(),
        org_id: org.id,
        tier: "free",
        payment_mode: "none",
        created_by: who.appUserId,
        created_at: nowIso,
        updated_at: nowIso,
      });
    await ensureBillingTask(d, tx, org.id, who.directusUserId);
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "account.enabled",
      detail: { stage: input.stage, previous: org.account_stage },
    });
  });
  return accountCard(d, org.id);
}

export async function updateAccount(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  patch: { account_stage?: string | undefined; account_manager_id?: string | null | undefined },
) {
  const org = await staffOrg(d, orgId);
  const now = d.now();
  await d.db.transaction(async (tx) => {
    if (patch.account_stage !== undefined)
      await store.updateOrg(tx, org.id, {
        account_stage: patch.account_stage,
        updated_at: now.toISOString(),
      });
    if (patch.account_manager_id !== undefined) {
      if (patch.account_manager_id !== null) {
        const user = isUuid(patch.account_manager_id)
          ? await store.appUser(tx, patch.account_manager_id)
          : null;
        if (!user) throw new BadRequestError("billing.account_manager_not_found");
        if (!(user.email ?? "").toLowerCase().endsWith("@dembrane.com"))
          throw new BadRequestError("billing.account_manager_not_staff");
      }
      const account = await store.billing(tx, org.id);
      if (!account) throw new ConflictError("billing.no_billing_account");
      await store.updateBilling(tx, account.id, {
        account_manager_id: patch.account_manager_id,
        updated_at: now.toISOString(),
      });
    }
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "account.updated",
      detail: patch as Record<string, unknown>,
    });
  });
  return accountCard(d, org.id);
}

// ── documents ───────────────────────────────────────────────────────────

export interface PushOfferInput {
  readonly template: OfferTemplate;
  readonly language: Language;
  readonly offer_name: string;
  readonly person_name: string | null;
  readonly attention: string | null;
  readonly reference: string | null;
  readonly title: string | null;
  readonly currency: string;
  readonly date: string | null;
  readonly items: readonly OfferItem[];
  readonly external_ref: string | null;
  readonly supersedes_id: string | null;
  /** False keeps a draft; staff send it later. */
  readonly send?: boolean;
}

const pin = (row: LegalRow) => ({
  version: row.version,
  effective_on: row.effectiveOn,
  url: row.sourceUrl,
});

function offerReference(dateIso: string, id: string): string {
  return `DMB-${dateIso.replace(/-/g, "")}-${id.slice(-4).toUpperCase()}`;
}

/** Voids a document that supersedes, withdrawing its signing task; a signed one stays. */
async function supersede(
  d: AccountsDeps,
  tx: Parameters<typeof store.org>[0],
  orgId: string,
  id: string,
  kind: string,
) {
  const prev = isUuid(id) ? await store.document(tx, orgId, id) : null;
  if (!prev || prev.kind !== kind) throw new NotFoundError("document.supersede_not_found");
  if (prev.status === "signed") throw new ConflictError("document.signed_cannot_supersede");
  const now = d.now();
  if (prev.status !== "void")
    await store.updateDocument(tx, prev.id, { status: "void", voidedAt: now, updatedAt: now });
  for (const t of await store.tasks(tx, orgId))
    if (t.documentId === prev.id && !["done", "withdrawn"].includes(t.status))
      await settleTask(d, tx, t.id, "withdrawn");
  return prev;
}

/**
 * Pushes an offer from lines and a template: renders it, pins the newest terms, SLA and
 * DPA (refreshed first when the last check is over an hour old; a failed fetch falls back
 * to the stored texts), sends it, and creates "Review and sign the offer" plus the locked
 * billing details task. An offer already sent keeps what it pinned; to pick up newer
 * texts, supersede it with a new push.
 */
export async function pushOffer(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: PushOfferInput,
  /** Fixed ids for the demo seed; the API never passes them. */
  ids: { document?: string; task?: string } = {},
) {
  const org = await staffOrg(d, orgId);
  const pinned = await legalForPush({
    db: d.db,
    fetchText: d.fetchText,
    logger: d.logger,
    now: d.now,
  });
  const now = d.now();
  const id = ids.document ?? newId();
  const date = input.date ?? now.toISOString().slice(0, 10);
  const reference = input.reference ?? offerReference(date, id);
  const content: OfferContent = {
    template: input.template,
    language: input.language,
    offer_name: input.offer_name,
    date,
    reference,
    person_name: input.person_name,
    attention: input.attention,
    currency: input.currency,
    valid_days: 14,
    company: {
      name: d.settings.company.name,
      address: d.settings.company.address,
      vat: d.settings.company.vat,
      kvk: d.settings.company.kvk,
      iban: d.settings.company.iban,
      bic: d.settings.company.bic,
    },
    legal: {
      terms: pin(pinned.terms),
      sla: pin(pinned.sla),
      dpa: pin(pinned.dpa),
    },
    items: input.items,
  };
  const totals = offerTotals(content);
  const body = offerText(content);
  // The PDF rendered now is what the customer sees and what a signature binds.
  const rendered = await offerPdf(content);
  const file = await storeRendered(d, org.id, id, rendered);
  let taskId = "";
  await d.db.transaction(async (tx) => {
    const prev = input.supersedes_id
      ? await supersede(d, tx, org.id, input.supersedes_id, "offer")
      : null;
    await store.insertDocument(tx, {
      id,
      orgId: org.id,
      kind: "offer",
      title: input.title ?? `${input.offer_name} x dembrane`,
      language: input.language,
      version: prev ? prev.version + 1 : 1,
      supersedesId: prev?.id ?? null,
      reference,
      template: input.template,
      content,
      body,
      ...file,
      requiresSignature: true,
      status: "draft",
      termsTextId: pinned.terms.id,
      slaTextId: pinned.sla.id,
      dpaTextId: pinned.dpa.id,
      lines: totals.lines,
      subtotalCents: totals.subtotal_cents,
      vatCents: totals.vat_cents,
      totalCents: totals.total_cents,
      currency: input.currency,
      validUntil: validUntil(date, 14),
      externalRef: input.external_ref,
      createdBy: who.directusUserId,
      createdAt: now,
      updatedAt: now,
    });
    // Fields go in while it is a draft; sending freezes them with the PDF.
    await writeFields(tx, id, rendered.fields);
    await ensureBillingTask(d, tx, org.id, who.directusUserId);
    if (input.send === false)
      await emit(d, tx, {
        orgId: org.id,
        actor: actorOf(who),
        type: "document.drafted",
        subject: { type: "document", id },
        detail: { kind: "offer", total_cents: totals.total_cents },
      });
    else taskId = await sendOfferIn(d, tx, who, org.id, id, ids.task);
  });
  const doc = (await store.document(d.db, org.id, id)) as DocumentRow;
  const task = taskId ? await store.task(d.db, org.id, taskId) : null;
  return {
    document: await documentDetail(d, doc, "staff"),
    task: task ? taskView(task, await store.documents(d.db, org.id)) : null,
  };
}

/**
 * Sends an offer that is still a draft: its PDF and fields freeze, "Review and sign the
 * offer" opens, and the timeline notes the legal versions it carries.
 */
async function sendOfferIn(
  d: AccountsDeps,
  tx: Conn,
  who: Signed,
  orgId: string,
  docId: string,
  taskId?: string,
): Promise<string> {
  const now = d.now();
  const doc = (await store.document(tx, orgId, docId)) as DocumentRow;
  await store.updateDocument(tx, docId, { status: "sent", sentAt: now, updatedAt: now });
  const task = await createTask(d, tx, {
    ...(taskId && { id: taskId }),
    orgId,
    code: "sign_offer",
    params: { document_title: doc.title },
    title: null,
    kind: "sign",
    documentId: docId,
    createdBy: who.directusUserId,
  });
  await ensureBillingTask(d, tx, orgId, who.directusUserId);
  const content = doc.content as OfferContent | null;
  await emit(d, tx, {
    orgId,
    actor: actorOf(who),
    type: "document.sent",
    subject: { type: "document", id: docId },
    detail: {
      kind: "offer",
      title: doc.title,
      total_cents: doc.totalCents,
      pinned: content
        ? {
            terms: content.legal.terms.version,
            sla: content.legal.sla.version,
            dpa: content.legal.dpa.version,
          }
        : null,
    },
  });
  return task.id;
}

/**
 * A draft offer sent later pins the texts that are newest then: when any changed since it
 * was drafted, its PDF, text and fields are rendered again before it freezes.
 */
async function repinDraftOffer(d: AccountsDeps, doc: DocumentRow): Promise<void> {
  const pinned = await legalForPush({
    db: d.db,
    fetchText: d.fetchText,
    logger: d.logger,
    now: d.now,
  });
  if (
    doc.termsTextId === pinned.terms.id &&
    doc.slaTextId === pinned.sla.id &&
    doc.dpaTextId === pinned.dpa.id
  )
    return;
  const content: OfferContent = {
    ...(doc.content as OfferContent),
    legal: { terms: pin(pinned.terms), sla: pin(pinned.sla), dpa: pin(pinned.dpa) },
  };
  const rendered = await offerPdf(content);
  const file = await storeRendered(d, doc.orgId, doc.id, rendered);
  await d.db.transaction(async (tx) => {
    await store.updateDocument(tx, doc.id, {
      content,
      body: offerText(content),
      ...file,
      termsTextId: pinned.terms.id,
      slaTextId: pinned.sla.id,
      dpaTextId: pinned.dpa.id,
      updatedAt: d.now(),
    });
    await writeFields(tx, doc.id, rendered.fields);
  });
}

export interface PushDocumentInput {
  readonly kind: "dpa" | "other";
  readonly title: string | null;
  readonly language: Language;
  /** Markdown. For a DPA without a body or PDF, the pinned DPA text is used. */
  readonly body: string | null;
  readonly pdf: Uint8Array | null;
  readonly requires_signature: boolean;
  readonly reference: string | null;
  readonly external_ref: string | null;
  readonly supersedes_id: string | null;
  /** A task for it once it is sent (a signing task when it needs a signature). */
  readonly task: { title: string; body: string | null } | null;
  /** Fields of an uploaded PDF; echo places them itself on documents it renders. */
  readonly fields: readonly PlacedField[] | null;
  readonly send: boolean;
}

/**
 * Pushes any document: a DPA for separate signing, a workshop plan, a customer's own PDF.
 * A text document is rendered to a PDF with a signing block when it needs a signature; an
 * uploaded PDF that needs one stays a draft until it has fields (given here, or placed
 * later with PUT .../fields) and is sent.
 */
export async function pushDocument(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: PushDocumentInput,
) {
  const org = await staffOrg(d, orgId);
  let body = input.body;
  let title = input.title;
  let dpaTextId: string | null = null;
  if (input.kind === "dpa" && !body && !input.pdf) {
    const pinned = await legalForPush({
      db: d.db,
      fetchText: d.fetchText,
      logger: d.logger,
      now: d.now,
    });
    body = pinned.dpa.body;
    title = title ?? `${pinned.dpa.title} ${pinned.dpa.version}`;
    dpaTextId = pinned.dpa.id;
  }
  if (!title) throw new ValidationError("document.title_required");
  if (!body && !input.pdf) throw new ValidationError("document.content_required");
  const id = newId();
  let file: { fileKey: string; sha256: string; pageCount: number };
  let fields: readonly PlacedField[] = [];
  if (input.pdf) {
    let pages: number;
    try {
      pages = await pageCountOf(input.pdf);
    } catch {
      throw new ValidationError("document.pdf_unreadable");
    }
    file = await storePdf(d, org.id, id, input.pdf, pages);
    fields = input.fields ?? [];
  } else {
    const rendered = await textPdf(title, body as string, {
      signing: input.requires_signature,
      language: input.language,
    });
    file = await storeRendered(d, org.id, id, rendered);
    fields = rendered.fields;
  }
  const problem = fields.length
    ? fieldProblems(fields, file.pageCount, input.requires_signature)
    : null;
  if (problem) throw new ValidationError("document.fields_invalid", { params: { problem } });
  // Sent now unless asked not to, or unless it needs a signature and has no fields yet.
  const send = input.send && !(input.requires_signature && !fields.length);
  const now = d.now();
  let taskId: string | null = null;
  await d.db.transaction(async (tx) => {
    const prev = input.supersedes_id
      ? await supersede(d, tx, org.id, input.supersedes_id, input.kind)
      : null;
    await store.insertDocument(tx, {
      id,
      orgId: org.id,
      kind: input.kind,
      title: title as string,
      language: input.language,
      version: prev ? prev.version + 1 : 1,
      supersedesId: prev?.id ?? null,
      reference: input.reference,
      body: body ?? (title as string),
      ...file,
      requiresSignature: input.requires_signature,
      status: "draft",
      dpaTextId,
      externalRef: input.external_ref,
      createdBy: who.directusUserId,
      createdAt: now,
      updatedAt: now,
    });
    await writeFields(tx, id, fields);
    if (send) taskId = await markSent(d, tx, who, org.id, id, input.task);
  });
  const doc = (await store.document(d.db, org.id, id)) as DocumentRow;
  const task = taskId ? await store.task(d.db, org.id, taskId) : null;
  return {
    document: await documentDetail(d, doc, "staff"),
    task: task ? taskView(task, await store.documents(d.db, org.id)) : null,
  };
}

/** Draft to sent: the PDF and fields freeze, the timeline notes it, and its task opens. */
async function markSent(
  d: AccountsDeps,
  tx: Conn,
  who: Signed,
  orgId: string,
  docId: string,
  task: { title: string; body: string | null } | null,
): Promise<string | null> {
  const now = d.now();
  const doc = (await store.document(tx, orgId, docId)) as DocumentRow;
  await store.updateDocument(tx, docId, { status: "sent", sentAt: now, updatedAt: now });
  let taskId: string | null = null;
  if (task)
    taskId = (
      await createTask(d, tx, {
        orgId,
        title: task.title,
        body: task.body,
        kind: doc.requiresSignature ? "sign" : "generic",
        documentId: docId,
        createdBy: who.directusUserId,
      })
    ).id;
  await emit(d, tx, {
    orgId,
    actor: actorOf(who),
    type: "document.sent",
    subject: { type: "document", id: docId },
    detail: { kind: doc.kind, title: doc.title },
  });
  return taskId;
}

export async function documentFields(d: AccountsDeps, orgId: string, docId: string) {
  const doc = await staffDocument(d, orgId, docId);
  return {
    document_id: doc.id,
    status: doc.status,
    page_count: doc.pageCount,
    fields: (await store.fields(d.db, doc.id)).map(fieldView),
  };
}

/** Staff place fields on a draft (the field editor); a sent document's fields are fixed. */
export async function setDocumentFields(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  fields: readonly PlacedField[],
) {
  const doc = await staffDocument(d, orgId, docId);
  if (doc.status !== "draft") throw new ConflictError("document.fields_fixed");
  const problem = fieldProblems(fields, doc.pageCount, false);
  if (problem) throw new ValidationError("document.fields_invalid", { params: { problem } });
  await d.db.transaction(async (tx) => {
    await writeFields(tx, doc.id, fields);
    await emit(d, tx, {
      orgId: doc.orgId,
      actor: actorOf(who),
      type: "document.fields_set",
      subject: { type: "document", id: doc.id },
      detail: { count: fields.length },
    });
  });
  return documentFields(d, orgId, docId);
}

export async function sendDocument(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  task: { title: string; body: string | null } | null,
) {
  let doc = await staffDocument(d, orgId, docId);
  if (doc.status !== "draft") throw new ConflictError("document.already_sent");
  if (doc.kind === "offer") {
    await repinDraftOffer(d, doc);
    doc = await staffDocument(d, orgId, docId);
    await d.db.transaction((tx) => sendOfferIn(d, tx, who, doc.orgId, doc.id));
    return documentDetail(
      d,
      (await store.document(d.db, doc.orgId, doc.id)) as DocumentRow,
      "staff",
    );
  }
  const fields = await store.fields(d.db, doc.id);
  const problem = fieldProblems(fields, doc.pageCount, doc.requiresSignature);
  if (problem) throw new ValidationError("document.fields_invalid", { params: { problem } });
  await d.db.transaction((tx) => markSent(d, tx, who, doc.orgId, doc.id, task));
  return documentDetail(d, (await store.document(d.db, doc.orgId, doc.id)) as DocumentRow, "staff");
}

export async function voidDocument(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  reason: string | null,
) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (!doc) throw new NotFoundError("document.not_found");
  if (doc.status === "signed") throw new ConflictError("document.signed_cannot_void");
  if (doc.status === "void") return documentDetail(d, doc, "staff");
  await d.db.transaction(async (tx) => {
    await supersede(d, tx, org.id, doc.id, doc.kind);
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "document.voided",
      subject: { type: "document", id: doc.id },
      detail: { reason },
    });
  });
  return documentDetail(d, (await store.document(d.db, org.id, doc.id)) as DocumentRow, "staff");
}

export async function staffDocument(d: AccountsDeps, orgId: string, docId: string) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (!doc) throw new NotFoundError("document.not_found");
  return doc;
}

export async function staffFile(
  d: AccountsDeps,
  orgId: string,
  docId: string,
  which: "file" | "signed",
) {
  const doc = await staffDocument(d, orgId, docId);
  return { doc, bytes: which === "file" ? await fileBytes(d, doc) : await signedBytes(d, doc) };
}

// ── invoices (sam) ──────────────────────────────────────────────────────

export interface InvoiceInput {
  readonly number: string;
  readonly issued_on: string;
  readonly due_on: string;
  readonly subtotal_cents: number;
  readonly vat_cents: number;
  readonly total_cents: number;
  readonly currency: string;
  readonly status: "open" | "paid" | "overdue" | "void";
  readonly paid_at: string | null;
  readonly payment_url: string | null;
  readonly payment_reference: string | null;
  readonly offer_id: string | null;
  readonly pdf: Uint8Array | null;
}

/**
 * sam's mirror of an Exact invoice, keyed on Exact's id. Number and amounts are fixed once
 * written (Exact never changes a numbered invoice); status, payment link and reference
 * follow Exact. Bank transfer details are always shown with it.
 */
export async function upsertInvoice(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  exactId: string,
  input: InvoiceInput,
) {
  const org = await staffOrg(d, orgId);
  if (input.subtotal_cents + input.vat_cents !== input.total_cents)
    throw new ValidationError("billing.invoice_total_mismatch");
  const existing = await store.documentByExactId(d.db, exactId);
  if (existing && existing.orgId !== org.id)
    throw new ConflictError("billing.invoice_other_organisation");
  const now = d.now();
  const body = [
    `Invoice ${input.number}`,
    `Issued ${input.issued_on}, due ${input.due_on}`,
    `Subtotal ${input.subtotal_cents} cents, VAT ${input.vat_cents} cents, total ${input.total_cents} cents ${input.currency}`,
  ].join("\n");
  const id = existing?.id ?? newId();
  let fileKey = existing?.fileKey ?? null;
  if (input.pdf) {
    fileKey = `accounts/${org.id}/invoices/${id}.pdf`;
    await d.files.put(fileKey, input.pdf, "application/pdf");
  }
  const payment = {
    invoiceStatus: input.status,
    paidAt: input.paid_at ? new Date(input.paid_at) : input.status === "paid" ? now : null,
    paymentUrl: input.payment_url,
    paymentReference: input.payment_reference,
    dueOn: input.due_on,
    fileKey,
    updatedAt: now,
  };
  await d.db.transaction(async (tx) => {
    if (existing) {
      if (existing.body !== body) throw new ConflictError("billing.invoice_immutable");
      await store.updateDocument(tx, existing.id, payment);
    } else {
      const offer =
        input.offer_id && isUuid(input.offer_id)
          ? await store.document(tx, org.id, input.offer_id)
          : null;
      await store.insertDocument(tx, {
        id,
        orgId: org.id,
        kind: "invoice",
        title: `Invoice ${input.number}`,
        language: offer?.language ?? "en",
        reference: input.number,
        body,
        sha256: sha256Hex(body),
        requiresSignature: false,
        status: "sent",
        subtotalCents: input.subtotal_cents,
        vatCents: input.vat_cents,
        totalCents: input.total_cents,
        currency: input.currency,
        exactId,
        issuedOn: input.issued_on,
        externalRef: offer?.externalRef ?? null,
        supersedesId: null,
        sentAt: now,
        createdBy: who.directusUserId,
        createdAt: now,
        ...payment,
      });
    }
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: existing ? "invoice.updated" : "invoice.created",
      subject: { type: "document", id },
      detail: { number: input.number, status: input.status, total_cents: input.total_cents },
    });
  });
  return documentDetail(d, (await store.document(d.db, org.id, id)) as DocumentRow, "staff");
}

// ── tasks ───────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  readonly title: string;
  readonly body: string | null;
  readonly kind: TaskKind;
  readonly document_id: string | null;
  readonly due_on: string | null;
  readonly locked_until_document_id: string | null;
  readonly reminder_interval_days: number | null;
}

export async function staffCreateTask(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: CreateTaskInput,
) {
  const org = await staffOrg(d, orgId);
  for (const ref of [input.document_id, input.locked_until_document_id])
    if (ref && !(isUuid(ref) && (await store.document(d.db, org.id, ref))))
      throw new NotFoundError("document.not_found");
  let id = "";
  await d.db.transaction(async (tx) => {
    const task = await createTask(d, tx, {
      orgId: org.id,
      title: input.title,
      body: input.body,
      kind: input.kind,
      documentId: input.document_id,
      dueOn: input.due_on,
      locked: Boolean(input.locked_until_document_id),
      unlockOnDocumentId: input.locked_until_document_id,
      reminderIntervalDays: input.reminder_interval_days,
      createdBy: who.directusUserId,
    });
    id = task.id;
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "task.created",
      subject: { type: "task", id },
      detail: { title: input.title, kind: input.kind },
    });
  });
  return taskView(
    (await store.task(d.db, org.id, id)) as NonNullable<Awaited<ReturnType<typeof store.task>>>,
    await store.documents(d.db, org.id),
  );
}

/** Approve (done), send back (open again, reminding), or withdraw (no longer asked). */
export async function reviewTask(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  taskId: string,
  decision: "approve" | "send_back" | "withdraw",
  note: string | null,
) {
  const org = await staffOrg(d, orgId);
  const task = isUuid(taskId) ? await store.task(d.db, org.id, taskId) : null;
  if (!task) throw new NotFoundError("task.not_found");
  if (["done", "withdrawn"].includes(task.status)) throw new ConflictError("task.already_closed");
  if (decision !== "withdraw" && task.status !== "submitted")
    throw new ConflictError("task.not_submitted");
  if (decision === "send_back" && !note) throw new ValidationError("task.note_required");
  const now = d.now();
  await d.db.transaction(async (tx) => {
    const review = { reviewedAt: now, reviewedBy: who.directusUserId, reviewNote: note };
    if (decision === "approve") await settleTask(d, tx, task.id, "done", review);
    else if (decision === "withdraw") await settleTask(d, tx, task.id, "withdrawn", review);
    else
      await store.updateTask(tx, task.id, {
        ...review,
        status: "changes_requested",
        nextReminderAt: new Date(
          now.getTime() +
            (task.reminderIntervalDays ?? d.settings.reminderIntervalDays) * 86_400_000,
        ),
        updatedAt: now,
      });
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: `task.${decision === "approve" ? "approved" : decision === "withdraw" ? "withdrawn" : "sent_back"}`,
      subject: { type: "task", id: task.id },
      detail: note ? { note } : {},
    });
  });
  return taskView(
    (await store.task(d.db, org.id, task.id)) as NonNullable<
      Awaited<ReturnType<typeof store.task>>
    >,
    await store.documents(d.db, org.id),
  );
}

// ── questions ───────────────────────────────────────────────────────────

export async function staffOpenTicket(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: { subject: string; body: string },
) {
  const org = await staffOrg(d, orgId);
  const now = d.now();
  const id = newId();
  await d.db.transaction(async (tx) => {
    await store.insertTicket(tx, {
      id,
      orgId: org.id,
      subject: input.subject,
      status: "waiting_on_customer",
      openedBy: who.directusUserId,
      createdAt: now,
      updatedAt: now,
    });
    await store.insertMessage(tx, {
      id: newId(),
      ticketId: id,
      authorUserId: who.directusUserId,
      fromStaff: true,
      body: input.body,
      createdAt: now,
    });
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "ticket.opened",
      subject: { type: "ticket", id },
    });
  });
  return ticketOf(d, org.id, id);
}

export async function staffReply(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  ticketId: string,
  input: { body: string; close: boolean },
) {
  const org = await staffOrg(d, orgId);
  const ticket = isUuid(ticketId) ? await store.ticket(d.db, org.id, ticketId) : null;
  if (!ticket) throw new NotFoundError("question.not_found");
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.insertMessage(tx, {
      id: newId(),
      ticketId: ticket.id,
      authorUserId: who.directusUserId,
      fromStaff: true,
      body: input.body,
      createdAt: now,
    });
    await store.updateTicket(tx, ticket.id, {
      status: input.close ? "closed" : "waiting_on_customer",
      closedAt: input.close ? now : null,
      updatedAt: now,
    });
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: input.close ? "ticket.closed" : "ticket.replied",
      subject: { type: "ticket", id: ticket.id },
    });
  });
  return ticketOf(d, org.id, ticket.id);
}

export async function closeTicket(d: AccountsDeps, who: Signed, orgId: string, ticketId: string) {
  const org = await staffOrg(d, orgId);
  const ticket = isUuid(ticketId) ? await store.ticket(d.db, org.id, ticketId) : null;
  if (!ticket) throw new NotFoundError("question.not_found");
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.updateTicket(tx, ticket.id, { status: "closed", closedAt: now, updatedAt: now });
    await emit(d, tx, {
      orgId: org.id,
      actor: actorOf(who),
      type: "ticket.closed",
      subject: { type: "ticket", id: ticket.id },
    });
  });
  return ticketOf(d, org.id, ticket.id);
}
