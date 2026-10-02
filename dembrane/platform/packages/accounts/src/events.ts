import { newId } from "@dembrane/core";
import { enqueueSamMessage } from "@dembrane/webhooks";
import type { AccountsDeps, Conn } from "./deps";
import { deliverEvent, notifySlack } from "./jobs";
import type { BillingRow, DocumentRow, OrgRow, SignatureRow, TaskRow, TicketRow } from "./storage";
import { store } from "./storage";
import { taskTitle } from "./task-text";

/**
 * What leaves echo when something happens on an account: a timeline row always, the
 * event for sam, and a Slack line for the three moments a person should hear about at
 * once. With sam's inbox configured the event goes there and sam posts the Slack line
 * itself, so echo sends none (one notice, not two); without it the event goes to
 * ACCOUNTS_EVENTS_URL and echo posts the line. All of it is written in the caller's
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

/**
 * Events only sam's inbox carries. ACCOUNTS_EVENTS_URL never received them, so without the
 * inbox they stay on the timeline, as before.
 */
export const INBOX_ONLY_EVENTS = ["account.call.booked"] as const;
export type InboxEvent = AccountEvent | (typeof INBOX_ONLY_EVENTS)[number];

const isAccountEvent = (e: InboxEvent): e is AccountEvent =>
  (ACCOUNT_EVENTS as readonly string[]).includes(e);

/**
 * The inbox code of each event. Named one by one, never derived from the dotted name, so
 * renaming an event cannot silently change what sam receives; a new payload shape is _v2.
 */
export const ACCOUNT_EVENT_CODES: Record<InboxEvent, string> = {
  "account.call.booked": "echo_account_call_booked_v1",
  "account.document.signed": "echo_account_document_signed_v1",
  "account.document.declined": "echo_account_document_declined_v1",
  "account.billing_details.updated": "echo_account_billing_details_updated_v1",
  "account.task.submitted": "echo_account_task_submitted_v1",
  "account.ticket.opened": "echo_account_ticket_opened_v1",
};

export type Actor = { kind: "customer" | "staff" | "system"; userId: string | null };

export interface Emit {
  readonly orgId: string;
  readonly actor: Actor;
  /** Timeline type, e.g. "document.signed", "task.created". */
  readonly type: string;
  readonly subject?: { type: string; id: string };
  readonly detail?: Record<string, unknown>;
  readonly webhook?: Record<string, unknown> & { event: InboxEvent };
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
  const toInbox = Boolean(e.webhook && d.settings.samInbox);
  if (e.webhook) {
    const payload = { id, timestamp: d.now().toISOString(), ...e.webhook };
    // The timeline event's id is the message id: sam deduplicates a redelivery on it.
    if (toInbox)
      await enqueueSamMessage(
        d.jobs,
        { code: ACCOUNT_EVENT_CODES[e.webhook.event], json: payload, id },
        { tx },
      );
    else if (d.settings.eventsEnabled && isAccountEvent(e.webhook.event))
      await d.jobs.enqueue(deliverEvent, { payload }, { tx });
  }
  if (e.slack && d.settings.slackEnabled && !toInbox)
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
