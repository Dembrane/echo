import { newId } from "@dembrane/core";
import type { AccountsDeps, Conn } from "./deps";
import { deliverEvent, notifySlack } from "./jobs";
import type { BillingRow, DocumentRow, OrgRow, SignatureRow, TaskRow, TicketRow } from "./storage";
import { store } from "./storage";
import { taskTitle } from "./task-text";

/**
 * What leaves echo when something happens on an account: a timeline row always, the
 * webhook event for sam when ACCOUNTS_EVENTS_URL is set, and a Slack line for the three
 * moments a person should hear about at once. All three are written in the caller's
 * transaction, so an event exists exactly when its cause committed.
 */

export const ACCOUNT_EVENTS = [
  "account.document.signed",
  "account.document.declined",
  "account.billing_details.updated",
  "account.task.submitted",
  "account.ticket.opened",
] as const;
export type AccountEvent = (typeof ACCOUNT_EVENTS)[number];

export type Actor = { kind: "customer" | "staff" | "system"; userId: string | null };

export interface Emit {
  readonly orgId: string;
  readonly actor: Actor;
  /** Timeline type, e.g. "document.signed", "task.created". */
  readonly type: string;
  readonly subject?: { type: string; id: string };
  readonly detail?: Record<string, unknown>;
  readonly webhook?: Record<string, unknown> & { event: AccountEvent };
  readonly slack?: string;
}

export async function emit(d: AccountsDeps, tx: Conn, e: Emit): Promise<void> {
  const id = newId();
  await store.insertEvent(tx, {
    id,
    orgId: e.orgId,
    actorKind: e.actor.kind,
    actorUserId: e.actor.userId,
    type: e.type,
    subjectType: e.subject?.type ?? null,
    subjectId: e.subject?.id ?? null,
    detail: e.detail ?? null,
    createdAt: d.now(),
  });
  if (e.webhook && d.settings.eventsEnabled)
    await d.jobs.enqueue(
      deliverEvent,
      { payload: { id, timestamp: d.now().toISOString(), ...e.webhook } },
      { tx },
    );
  if (e.slack && d.settings.slackEnabled)
    await d.jobs.enqueue(notifySlack, { text: e.slack }, { tx });
}

// ── payloads: stable, documented in the README, read by sam's invoice_request ──

export function orgPayload(o: OrgRow) {
  return { id: o.id, name: o.name, account_stage: o.account_stage };
}

export function billingPayload(b: BillingRow | null) {
  return {
    legal_name: b?.billing_legal_name ?? null,
    vat_id: b?.billing_vat_id ?? null,
    kvk_number: b?.kvk_number ?? null,
    kbo_number: b?.kbo_number ?? null,
    billing_email: b?.billing_email ?? null,
    po_number: b?.po_number ?? null,
    peppol_id: b?.peppol_id ?? null,
    address: {
      line1: b?.billing_address_line1 ?? null,
      line2: b?.billing_address_line2 ?? null,
      postal_code: b?.billing_postal_code ?? null,
      city: b?.billing_city ?? null,
      country: b?.billing_country ?? null,
    },
  };
}

export function documentPayload(doc: DocumentRow) {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    reference: doc.reference,
    language: doc.language,
    version: doc.version,
    template: doc.template,
    sha256: doc.sha256,
    external_ref: doc.externalRef,
    currency: doc.currency,
    lines: doc.lines ?? null,
    subtotal_cents: doc.subtotalCents,
    vat_cents: doc.vatCents,
    total_cents: doc.totalCents,
    valid_until: doc.validUntil,
  };
}

export function signaturePayload(s: SignatureRow, signedPdfPath: string) {
  return {
    id: s.id,
    name: s.typedName,
    role: s.typedRole,
    email: s.email,
    organisation: s.organisation,
    address: s.address,
    vat_number: s.vatNumber,
    dpa_authorised: s.dpaAuthorised,
    signed_at: s.signedAt.toISOString(),
    sha256: s.sha256,
    signed_pdf_sha256: s.signedPdfSha256,
    /** Staff API path; sam fetches it with its staff key. */
    signed_pdf: signedPdfPath,
  };
}

export function taskPayload(t: TaskRow) {
  return {
    id: t.id,
    // Worded in English for sam; the code and params are what a program should read.
    title: taskTitle(t, "en-US"),
    code: t.code,
    params: t.params ?? null,
    kind: t.kind,
    document_id: t.documentId,
    response_text: t.responseText,
    has_file: Boolean(t.responseFileKey),
  };
}

export function ticketPayload(t: TicketRow, firstMessage: string) {
  return { id: t.id, subject: t.subject, message: firstMessage };
}
