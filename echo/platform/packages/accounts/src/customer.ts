import { ORG_ROLE_POLICIES, type OrgRole } from "@echo/access";
import { sendEmail } from "@echo/account";
import { ConflictError, ForbiddenError, NotFoundError, newId, ValidationError } from "@echo/core";
import type { Signed } from "@echo/http";
import { customerOrg, documentFor } from "./access";
import type { AccountsDeps } from "./deps";
import { billingPayload, emit, orgPayload, taskPayload, ticketPayload } from "./events";
import { accountPageUrl } from "./jobs";
import type { PricedLine } from "./money";
import type { OfferContent } from "./offer";
import { type DocumentRow, store } from "./storage";
import { isTaskCode } from "./task-text";
import { settleTask } from "./tasks";
import {
  billingView,
  confirmationText,
  customerBase,
  documentSummary,
  fieldView,
  legalView,
  signatureView,
  signingNote,
  staffBase,
  taskView,
  ticketView,
} from "./views";

/** The customer's account, as one page reads it: tasks, documents, billing, questions. */
export async function accountPage(d: AccountsDeps, who: Signed, orgId: string) {
  const org = await customerOrg(d, who, orgId, "account:read");
  const [docs, sigs, tasks, tickets, billing] = await Promise.all([
    store.documents(d.db, org.id),
    store.signatures(d.db, org.id),
    store.tasks(d.db, org.id),
    store.tickets(d.db, org.id),
    store.billing(d.db, org.id),
  ]);
  const messages = await store.messages(
    d.db,
    tickets.map((t) => t.id),
  );
  const pricing = org.origin_pricing_configuration_id
    ? await store.pricingById(d.db, org.origin_pricing_configuration_id)
    : null;
  return {
    organisation: { id: org.id, name: org.name, account_stage: org.account_stage },
    // Next steps first: what waits on the customer, then what waits on us, then the rest.
    tasks: tasks
      .filter((t) => t.status !== "withdrawn")
      .sort((a, b) => taskOrder(a.status) - taskOrder(b.status))
      .map((t) => taskView(t, docs)),
    documents: docs
      .filter((x) => x.status !== "draft" && x.status !== "void")
      .map((x) =>
        documentSummary(
          x,
          sigs.find((s) => s.documentId === x.id) ?? null,
          d.settings.company,
          customerBase(org.id),
        ),
      ),
    billing: billingView(billing),
    tickets: tickets.map((t) => ticketView(t, messages)),
    needs_form_reference: pricing?.reference ?? null,
  };
}

const ORDER = ["open", "changes_requested", "locked", "submitted", "done"];
const taskOrder = (s: string) => {
  const i = ORDER.indexOf(s);
  return i < 0 ? ORDER.length : i;
};

/** One document with everything the signing screen shows. */
export async function readDocument(d: AccountsDeps, who: Signed, orgId: string, docId: string) {
  const a = await documentFor(d, who, orgId, docId, "account:read");
  return documentDetail(d, a.doc, a.via);
}

export async function documentDetail(
  d: AccountsDeps,
  doc: DocumentRow,
  via: "member" | "signer" | "staff",
) {
  const [sig, fields, terms, sla, dpa] = await Promise.all([
    store.signatureOf(d.db, doc.id),
    store.fields(d.db, doc.id),
    store.legalById(d.db, doc.termsTextId),
    store.legalById(d.db, doc.slaTextId),
    store.legalById(d.db, doc.dpaTextId),
  ]);
  // Placeholders for what the signer's fields provide; the organisation's own name when
  // the document has no organisation field, and no role when it has no role field.
  const org = await store.org(d.db, doc.orgId);
  const has = (pick: (f: (typeof fields)[number]) => boolean) => fields.some(pick);
  const placeholders = {
    name: "{name}",
    role: has((f) => f.kind === "role") ? "{role}" : "",
    organisation: has((f) => f.kind === "text" && f.key === "organisation")
      ? "{organisation}"
      : (org?.name ?? ""),
  };
  return {
    ...documentSummary(
      doc,
      sig,
      d.settings.company,
      via === "staff" ? staffBase(doc.orgId) : customerBase(doc.orgId),
    ),
    body: doc.body,
    content: (doc.content ?? null) as OfferContent | null,
    lines: (doc.lines ?? null) as PricedLine[] | null,
    sha256: doc.sha256,
    page_count: doc.pageCount,
    fields: fields.map(fieldView),
    legal: [legalView("terms", terms), legalView("sla", sla), legalView("dpa", dpa)].filter(
      Boolean,
    ),
    signing_note: doc.requiresSignature ? signingNote(doc) : null,
    // The sentence the signer confirms; the page fills in the three values it asks for.
    confirmation: doc.requiresSignature
      ? {
          dpa_authorised: confirmationText(doc, { ...placeholders, dpa_authorised: true }),
          dpa_not_authorised:
            doc.kind === "offer"
              ? confirmationText(doc, { ...placeholders, dpa_authorised: false })
              : null,
        }
      : null,
    signature: sig ? signatureView(sig) : null,
    access: via,
  };
}

/** The first open marks a sent document viewed; later opens change nothing. */
export async function markViewed(d: AccountsDeps, who: Signed, orgId: string, docId: string) {
  const a = await documentFor(d, who, orgId, docId, "account:read");
  if (a.doc.status !== "sent") return { status: a.doc.status };
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.updateDocument(tx, a.doc.id, { status: "viewed", viewedAt: now, updatedAt: now });
    await emit(d, tx, {
      orgId: a.org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "document.viewed",
      subject: { type: "document", id: a.doc.id },
    });
  });
  return { status: "viewed" };
}

export async function declineDocument(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  reason: string | null,
) {
  const a = await documentFor(d, who, orgId, docId, "account:sign");
  if (!a.doc.requiresSignature || !["sent", "viewed"].includes(a.doc.status))
    throw new ConflictError("This document cannot be declined now");
  if (a.doc.signerEmail && a.doc.signerEmail.toLowerCase() !== a.email)
    throw new ForbiddenError(`Only ${a.doc.signerEmail} can decline this document`);
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.updateDocument(tx, a.doc.id, {
      status: "declined",
      declinedAt: now,
      declineReason: reason,
      updatedAt: now,
    });
    for (const t of await store.tasks(tx, a.org.id))
      if (
        t.kind === "sign" &&
        t.documentId === a.doc.id &&
        !["done", "withdrawn"].includes(t.status)
      )
        await settleTask(d, tx, t.id, "withdrawn");
    await emit(d, tx, {
      orgId: a.org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "document.declined",
      subject: { type: "document", id: a.doc.id },
      detail: { reason },
      webhook: {
        event: "account.document.declined",
        org: orgPayload(a.org),
        document: {
          id: a.doc.id,
          kind: a.doc.kind,
          title: a.doc.title,
          reference: a.doc.reference,
          external_ref: a.doc.externalRef,
        },
        declined_by: a.email,
        reason,
      },
    });
  });
  return { status: "declined" };
}

/**
 * Names someone else to sign. They get an email with a link; signing in with a code sent
 * to that address reaches this one document and nothing else of the organisation.
 */
export async function nameSigner(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  signer: { name: string; email: string; role: string | null },
) {
  const org = await customerOrg(d, who, orgId, "account:sign");
  const doc = await store.document(d.db, org.id, docId);
  if (!doc || doc.status === "draft") throw new NotFoundError("Document not found");
  if (!doc.requiresSignature || !["sent", "viewed"].includes(doc.status))
    throw new ConflictError("This document is not waiting for a signature");
  const email = signer.email.trim().toLowerCase();
  const now = d.now();
  const me = await store.identity(d.db, who.directusUserId);
  await d.db.transaction(async (tx) => {
    await store.updateDocument(tx, doc.id, {
      signerEmail: email,
      signerName: signer.name,
      signerRole: signer.role,
      signerInvitedAt: now,
      updatedAt: now,
    });
    await d.jobs.enqueue(
      sendEmail,
      {
        to: email,
        subject: `Please sign ${doc.title}`,
        template: "account_signer_invite",
        data: {
          inviter_name: me?.name || me?.email || org.name,
          org_name: org.name,
          document_title: doc.title,
          sign_url: `${accountPageUrl(d.settings.dashboardUrl, org.id)}/documents/${doc.id}/sign`,
        },
        context: `account signer invite ${doc.id}`,
      },
      { tx },
    );
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "document.signer_named",
      subject: { type: "document", id: doc.id },
      detail: { email, name: signer.name },
    });
  });
  return { signer: { email, name: signer.name, role: signer.role } };
}

/** Documents waiting for the caller's own signature, in any organisation. */
export async function mySigningRequests(d: AccountsDeps, who: Signed) {
  const me = await store.identity(d.db, who.directusUserId);
  if (!me?.verified) return [];
  const docs = await store.waitingForSigner(d.db, me.email);
  const out = [];
  for (const doc of docs) {
    const org = await store.org(d.db, doc.orgId);
    if (!org || org.deleted_at) continue;
    out.push({
      organisation: { id: org.id, name: org.name },
      document: documentSummary(doc, null, d.settings.company, customerBase(org.id)),
    });
  }
  return out;
}

/** The unsigned PDF: what the viewer renders and the fields overlay. */
export async function fileBytes(d: AccountsDeps, doc: DocumentRow): Promise<Uint8Array> {
  const blob = doc.fileKey ? await d.files.get(doc.fileKey) : null;
  if (!blob) throw new NotFoundError("This document has no PDF");
  return new Uint8Array(await blob.arrayBuffer());
}

/** The signed PDF, once signed. */
export async function signedBytes(d: AccountsDeps, doc: DocumentRow): Promise<Uint8Array> {
  const sig = await store.signatureOf(d.db, doc.id);
  const blob = sig ? await d.files.get(sig.signedPdfKey) : null;
  if (!blob) throw new NotFoundError("This document is not signed");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function customerFile(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  which: "file" | "signed",
) {
  const a = await documentFor(d, who, orgId, docId, "account:read");
  return {
    doc: a.doc,
    bytes: which === "file" ? await fileBytes(d, a.doc) : await signedBytes(d, a.doc),
  };
}

// ── billing details ─────────────────────────────────────────────────────

export interface BillingInput {
  readonly legal_name: string;
  readonly billing_email: string;
  readonly address_line1: string;
  readonly address_line2: string | null;
  readonly postal_code: string;
  readonly city: string;
  readonly country: string;
  readonly vat_id: string | null;
  readonly kvk_number: string | null;
  readonly kbo_number: string | null;
  readonly po_number: string | null;
  readonly peppol_id: string | null;
}

export async function readBilling(d: AccountsDeps, who: Signed, orgId: string) {
  const org = await customerOrg(d, who, orgId, "account:billing");
  return billingView(await store.billing(d.db, org.id));
}

/**
 * Saves what Exact needs to invoice, on the organisation's own billing account (made if it
 * has none yet), and completes the billing details task: no review by us.
 */
export async function updateBilling(d: AccountsDeps, who: Signed, orgId: string, b: BillingInput) {
  const org = await customerOrg(d, who, orgId, "account:billing");
  if (!b.vat_id && !b.kvk_number && !b.kbo_number)
    throw new ValidationError("Give at least one of the VAT, KvK or KBO number");
  const now = d.now();
  const me = await store.identity(d.db, who.directusUserId);
  await d.db.transaction(async (tx) => {
    const patch = {
      billing_legal_name: b.legal_name,
      billing_email: b.billing_email.trim().toLowerCase(),
      billing_address_line1: b.address_line1,
      billing_address_line2: b.address_line2,
      billing_postal_code: b.postal_code,
      billing_city: b.city,
      billing_country: b.country,
      billing_vat_id: b.vat_id,
      kvk_number: b.kvk_number,
      kbo_number: b.kbo_number,
      po_number: b.po_number,
      peppol_id: b.peppol_id,
      updated_at: now.toISOString(),
    };
    const account = await store.billing(tx, org.id);
    if (account) await store.updateBilling(tx, account.id, patch);
    else
      await store.insertBilling(tx, {
        id: newId(),
        org_id: org.id,
        tier: "free",
        payment_mode: "none",
        created_at: now.toISOString(),
        ...patch,
      });
    // Saving the details completes the task; we hear about it, we do not review it.
    for (const t of await store.tasks(tx, org.id))
      if (
        t.kind === "billing_details" &&
        ["locked", "open", "changes_requested", "submitted"].includes(t.status)
      )
        await settleTask(d, tx, t.id, "done", {
          submittedAt: now,
          submittedBy: who.directusUserId,
        });
    const billing = await store.billing(tx, org.id);
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "billing_details.updated",
      detail: { by: me?.email ?? null },
      webhook: {
        event: "account.billing_details.updated",
        org: orgPayload(org),
        billing: billingPayload(billing),
        updated_by: me?.email ?? null,
      },
      slack: `:receipt: Billing details for ${org.name} submitted by ${me?.email ?? "a member"}: ${b.legal_name}${b.po_number ? `, PO ${b.po_number}` : ""}.`,
    });
  });
  return billingView(await store.billing(d.db, org.id));
}

// ── tasks ───────────────────────────────────────────────────────────────

export interface TaskFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export const MAX_TASK_FILE_BYTES = 20 * 1024 * 1024;

/** Submits a generic or upload task; signing and billing tasks settle through their own steps. */
export async function submitTask(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  taskId: string,
  input: { text: string | null; file: TaskFile | null },
) {
  const org = await customerOrg(d, who, orgId, "account:tasks");
  const task = await store.task(d.db, org.id, taskId);
  if (!task) throw new NotFoundError("Task not found");
  if (task.kind === "sign") throw new ConflictError("This task is done by signing the document");
  if (task.kind === "billing_details")
    throw new ConflictError("This task is done by saving the billing details");
  if (!["open", "changes_requested"].includes(task.status))
    throw new ConflictError(
      task.status === "locked" ? "This task is not open yet" : "This task is not waiting for you",
    );
  if (task.kind === "upload" && !input.file) throw new ValidationError("This task needs a file");
  if (!input.text && !input.file) throw new ValidationError("Add a reply or a file");
  if (input.file && input.file.bytes.byteLength > MAX_TASK_FILE_BYTES)
    throw new ValidationError("The file is larger than 20 MB");
  const now = d.now();
  let key: string | null = null;
  if (input.file) {
    const safe = input.file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
    key = `accounts/${org.id}/tasks/${task.id}/${newId()}-${safe}`;
    await d.files.put(key, input.file.bytes, input.file.type || "application/octet-stream");
  }
  await d.db.transaction(async (tx) => {
    await settleTask(d, tx, task.id, "submitted", {
      responseText: input.text,
      ...(key && { responseFileKey: key, responseFileName: input.file?.name ?? null }),
      submittedAt: now,
      submittedBy: who.directusUserId,
    });
    const fresh = (await store.task(tx, org.id, task.id)) as NonNullable<
      Awaited<ReturnType<typeof store.task>>
    >;
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "task.submitted",
      subject: { type: "task", id: task.id },
      webhook: { event: "account.task.submitted", org: orgPayload(org), task: taskPayload(fresh) },
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

export async function openTicket(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: { subject: string; body: string },
) {
  const org = await customerOrg(d, who, orgId, "account:support");
  const now = d.now();
  const id = newId();
  const me = await store.identity(d.db, who.directusUserId);
  await d.db.transaction(async (tx) => {
    await store.insertTicket(tx, {
      id,
      orgId: org.id,
      subject: input.subject,
      status: "waiting_on_dembrane",
      openedBy: who.directusUserId,
      createdAt: now,
      updatedAt: now,
    });
    await store.insertMessage(tx, {
      id: newId(),
      ticketId: id,
      authorUserId: who.directusUserId,
      fromStaff: false,
      body: input.body,
      createdAt: now,
    });
    const ticket = (await store.ticket(tx, org.id, id)) as NonNullable<
      Awaited<ReturnType<typeof store.ticket>>
    >;
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "ticket.opened",
      subject: { type: "ticket", id },
      webhook: {
        event: "account.ticket.opened",
        org: orgPayload(org),
        ticket: ticketPayload(ticket, input.body),
        opened_by: me?.email ?? null,
      },
      slack: `:speech_balloon: New question from ${org.name} (${me?.email ?? "a member"}): ${input.subject}`,
    });
  });
  return ticketOf(d, org.id, id);
}

export async function customerReply(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  ticketId: string,
  body: string,
) {
  const org = await customerOrg(d, who, orgId, "account:support");
  const ticket = await store.ticket(d.db, org.id, ticketId);
  if (!ticket) throw new NotFoundError("Question not found");
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.insertMessage(tx, {
      id: newId(),
      ticketId: ticket.id,
      authorUserId: who.directusUserId,
      fromStaff: false,
      body,
      createdAt: now,
    });
    await store.updateTicket(tx, ticket.id, {
      status: "waiting_on_dembrane",
      closedAt: null,
      updatedAt: now,
    });
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "ticket.replied",
      subject: { type: "ticket", id: ticket.id },
    });
  });
  return ticketOf(d, org.id, ticket.id);
}

export async function ticketOf(d: AccountsDeps, orgId: string, ticketId: string) {
  const ticket = await store.ticket(d.db, orgId, ticketId);
  if (!ticket) throw new NotFoundError("Question not found");
  return ticketView(ticket, await store.messages(d.db, [ticket.id]));
}

/** A call booked through the cal.com step, on the timeline and on the staff card. */
export async function recordBooking(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  booking: { uid: string; start: string | null; status: string | null },
) {
  const org = await customerOrg(d, who, orgId, "account:support");
  await d.db.transaction(async (tx) => {
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "booking.recorded",
      subject: { type: "booking", id: booking.uid },
      detail: { start: booking.start, status: booking.status },
    });
  });
  return { recorded: true };
}

/** The roles whose holders run an account, straight from the access policies. */
const ACCOUNT_ROLES = (Object.keys(ORG_ROLE_POLICIES) as OrgRole[]).filter((r) =>
  ORG_ROLE_POLICIES[r].has("account:read"),
);

/**
 * Every organisation whose account the caller runs, with task counts and the next task:
 * the "Tasks 1/2" entry and the org picker. One indexed query; cheap on every page load.
 */
export async function tasksSummary(d: AccountsDeps, who: Signed) {
  if (!who.appUserId) return [];
  const rows = await store.tasksSummary(d.db, who.appUserId, ACCOUNT_ROLES);
  return rows.map(({ next_task, ...r }) => ({
    ...r,
    account_stage: r.account_stage as "prospect" | "customer" | "churned" | null,
    next_task_title: next_task?.code ? null : (next_task?.title ?? null),
    next_task_code: isTaskCode(next_task?.code) ? next_task.code : null,
    next_task_params: next_task?.code ? ((next_task.params ?? {}) as Record<string, string>) : null,
  }));
}
