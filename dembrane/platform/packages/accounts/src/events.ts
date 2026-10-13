import { newId } from "@dembrane/core";
import { enqueueSamMessage } from "@dembrane/webhooks";
import { DELIVERIES, type Delivery } from "./billing-rules";
import type { AccountsDeps, AccountsSettings, Conn } from "./deps";
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
 *
 * `account.document.sent` and `account.document.voided` tell sam what staff did with a
 * document, so it can close its review step and move the deal. `account.invoice.requested`
 * is the one message a person needs to send an invoice: see invoice.ts.
 * `account.task.waiting` says a task has waited on the customer for its interval, so the
 * account's owner at dembrane checks in; echo itself writes the customer nothing: see
 * runTaskReminder in jobs.ts.
 */
export const INBOX_ONLY_EVENTS = [
  "account.call.booked",
  "account.document.sent",
  "account.document.voided",
  "account.invoice.requested",
  "account.task.waiting",
] as const;
export type InboxEvent = AccountEvent | (typeof INBOX_ONLY_EVENTS)[number];

const isAccountEvent = (e: InboxEvent): e is AccountEvent =>
  (ACCOUNT_EVENTS as readonly string[]).includes(e);

/** The offer flow's messages: made only where sam is known to take them (offerMessages). */
const OFFER_FLOW: readonly InboxEvent[] = [
  "account.document.sent",
  "account.document.voided",
  "account.invoice.requested",
  "account.task.waiting",
];

/** Whether a message for this event leaves for sam's inbox under these settings. */
export function inboxTakes(
  s: Pick<AccountsSettings, "samInbox" | "offerMessages">,
  event: InboxEvent,
): boolean {
  return s.samInbox && (s.offerMessages || !OFFER_FLOW.includes(event));
}

/**
 * The inbox code of each event. Named one by one, never derived from the dotted name, so
 * renaming an event cannot silently change what sam receives; a new payload shape is _v2.
 */
export const ACCOUNT_EVENT_CODES: Record<InboxEvent, string> = {
  "account.call.booked": "echo_account_call_booked_v1",
  "account.document.sent": "echo_account_document_sent_v1",
  "account.document.voided": "echo_account_document_voided_v1",
  "account.invoice.requested": "echo_account_invoice_requested_v1",
  "account.task.waiting": "echo_account_task_waiting_v1",
  "account.document.signed": "echo_account_document_signed_v1",
  "account.document.declined": "echo_account_document_declined_v1",
  "account.billing_details.updated": "echo_account_billing_details_updated_v1",
  "account.task.submitted": "echo_account_task_submitted_v1",
  "account.ticket.opened": "echo_account_ticket_opened_v1",
};

export type Actor = { kind: "customer" | "staff" | "system"; userId: string | null };

/** What `emit` reads: the API passes its dependencies, a worker job the few it has. */
export type EmitDeps = Pick<AccountsDeps, "jobs" | "now"> & {
  readonly settings: Pick<
    AccountsSettings,
    "samInbox" | "offerMessages" | "eventsEnabled" | "slackEnabled"
  >;
};

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

export async function emit(d: EmitDeps, tx: Conn, e: Emit): Promise<void> {
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
  const held = e.webhook && OFFER_FLOW.includes(e.webhook.event) && !d.settings.offerMessages;
  const toInbox = Boolean(e.webhook && d.settings.samInbox && !held);
  if (e.webhook && !held) {
    // The manager is read here, in the cause's transaction, and frozen into the stored
    // payload: a message already queued keeps the manager it was written with, so a retry
    // or a late drain never re-addresses it to someone who took the account over since.
    const payload = {
      id,
      timestamp: d.now().toISOString(),
      ...e.webhook,
      account_manager: await accountManagerPayload(tx, e.orgId),
    };
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

// ── payloads: stable, read by sam's invoice_request and its account handling ──
//
// Every account message carries, beside its event fields:
//   id               the timeline event's id, sam's deduplication key
//   timestamp        ISO time the cause committed
//   event            the dotted event name
//   account_manager  { email: string, name: string | null } or null: who at dembrane owns
//                    this customer when the event happened, so sam can tag them and give
//                    them the follow-up. Null when the organisation has no manager set.
// The builders below are the shape of each event's own fields; a breaking change to any
// of it is a new _v2 code, never an edit here.

/** The organisation's account manager as sam reads it; null when none is set. */
export async function accountManagerPayload(
  c: Conn,
  orgId: string,
): Promise<{ email: string; name: string | null } | null> {
  const billing = await store.billing(c, orgId);
  if (!billing?.account_manager_id) return null;
  const user = await store.appUser(c, billing.account_manager_id);
  // A manager without an email cannot be tagged; it reads as unset rather than as a blank.
  if (!user?.email) return null;
  return { email: user.email, name: user.display_name || null };
}

export function orgPayload(o: OrgRow) {
  return { id: o.id, name: o.name, account_stage: o.account_stage };
}

/**
 * How the invoice reaches the customer: the choice made, else Peppol when the customer is
 * on it. `other` is a way Exact cannot send by itself: a person sends the invoice.
 */
export function invoiceDelivery(b: BillingRow | null): Delivery {
  const chosen = DELIVERIES.find((way) => way === b?.invoice_delivery);
  return chosen ?? (b?.peppol_id ? "peppol" : "email");
}

export function billingPayload(b: BillingRow | null) {
  return {
    legal_name: b?.billing_legal_name ?? null,
    vat_id: b?.billing_vat_id ?? null,
    // true: the customer said it has no VAT number. false: asked, and it gave one. null: not asked.
    no_vat_number: b?.no_vat_number ?? null,
    kvk_number: b?.kvk_number ?? null,
    kbo_number: b?.kbo_number ?? null,
    billing_email: b?.billing_email ?? null,
    po_number: b?.po_number ?? null,
    peppol_id: b?.peppol_id ?? null,
    invoice_delivery: invoiceDelivery(b),
    // How the customer receives invoices, in their words; set only with delivery "other".
    invoice_portal: b?.invoice_portal ?? null,
    address: {
      line1: b?.billing_address_line1 ?? null,
      line2: b?.billing_address_line2 ?? null,
      postal_code: b?.billing_postal_code ?? null,
      city: b?.billing_city ?? null,
      country: b?.billing_country ?? null,
      // ISO 3166-1 alpha-2; null for details saved before the form had a list of countries.
      country_code: b?.billing_country_code ?? null,
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

const DAY_MS = 86_400_000;

/** Since when a task waits on the customer: its opening, or the day it was sent back. */
function waitingSince(t: TaskRow): Date {
  const opened = t.openedAt ?? t.createdAt;
  return t.status === "changes_requested" ? (t.reviewedAt ?? opened) : opened;
}

/**
 * `account.task.waiting`: the task, since when it waits on the customer, and how often
 * the account's owner has been asked to check in, this time included.
 */
export function waitingTaskPayload(t: TaskRow, now: Date, timesAsked: number) {
  const since = waitingSince(t);
  return {
    ...taskPayload(t),
    status: t.status,
    waiting_since: since.toISOString(),
    days_waiting: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)),
    times_asked: timesAsked,
  };
}

export function ticketPayload(t: TicketRow, firstMessage: string) {
  return { id: t.id, subject: t.subject, message: firstMessage };
}
