import { sendEmail } from "@dembrane/account";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
  ValidationError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { localeOfEmail, resolveLocale, translator } from "@dembrane/i18n";
import {
  ACCOUNT_ROLES,
  assertMayNameSigner,
  bringsInNewPeople,
  customerOrg,
  customerOrgAs,
  documentFor,
  inRoom,
  roomOrg,
  verifiedEmail,
} from "./access";
import { checkBilling, countryCodeOf, countryName, type Delivery } from "./billing-rules";
import { customerEmailFor } from "./customer-email";
import { type AccountsDeps, type Conn, isUuid, type Tx } from "./deps";
import { type Actor, billingPayload, emit, orgPayload, taskPayload, ticketPayload } from "./events";
import { signerInviteUrl } from "./invite";
import { customerSignUrl, requestInvoices, staffDocumentUrl } from "./invoice";
import { legalTextPage } from "./legal/page";
import type { PricedLine } from "./money";
import type { OfferContent } from "./offer";
import { completeOnboarding, isOnboardingCode } from "./onboarding";
import { lookupPeppol, type TaxIds } from "./peppol";
import { continueUrl } from "./prospect";
import { awaitingSlots, customerSlot, fieldsOf, type Slot, slotsOf } from "./signers";
import { type BillingRow, type DocumentRow, store } from "./storage";
import { isTaskCode } from "./task-text";
import { settleTask } from "./tasks";
import { fieldErrors } from "./validate";
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

/**
 * The customer's account, as one page reads it: tasks, documents, billing, questions. A
 * room member reads the offer and the DPA and every task on them, answers and reviews
 * included (the room is open among colleagues): nothing about paying or billing details,
 * and no questions to dembrane.
 */
export async function accountPage(d: AccountsDeps, who: Signed, orgId: string) {
  const { org, via, role } = await roomOrg(d, who, orgId);
  const room = via === "room";
  const mayNameSigner = bringsInNewPeople(role);
  const [allDocs, sigs, allTasks, allTickets, billing, reminded] = await Promise.all([
    store.documents(d.db, org.id),
    store.signatures(d.db, org.id),
    store.tasks(d.db, org.id),
    room ? [] : store.tickets(d.db, org.id),
    room ? null : store.billing(d.db, org.id),
    store.lastReminders(d.db, org.id),
  ]);
  const docs = room ? allDocs.filter(inRoom) : allDocs;
  const tasks = room
    ? allTasks.filter(
        (t) => t.kind !== "billing_details" && docs.some((x) => x.id === t.documentId),
      )
    : allTasks;
  const tickets = room ? [] : allTickets;
  const messages = await store.messages(
    d.db,
    tickets.map((t) => t.id),
  );
  const pricing =
    !room && org.origin_pricing_configuration_id
      ? await store.pricingById(d.db, org.origin_pricing_configuration_id)
      : null;
  return {
    organisation: { id: org.id, name: org.name, account_stage: org.account_stage },
    access: via,
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
          reminded.get(x.id) ?? null,
          room,
          mayNameSigner,
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
  return documentDetail(d, a.doc, a.via, who, true, bringsInNewPeople(a.role));
}

export async function documentDetail(
  d: AccountsDeps,
  doc: DocumentRow,
  via: "member" | "signer" | "room" | "staff",
  /** The staff member asking; signs the email in `customer_email`. */
  viewer: Signed | null = null,
  /** False leaves `customer_email` out: the preview seed runs without the server catalogs. */
  withEmail = true,
  /** The caller may name someone to sign: an owner or admin reading as a member. */
  mayNameSigner = false,
) {
  const [sig, allFields, terms, sla, dpa, reminded, all] = await Promise.all([
    store.signatureOf(d.db, doc.id),
    store.fields(d.db, doc.id),
    store.legalById(d.db, doc.termsTextId),
    store.legalById(d.db, doc.slaTextId),
    store.legalById(d.db, doc.dpaTextId),
    store.lastReminders(d.db, doc.orgId, doc.id),
    store.signaturesOf(d.db, doc.id),
  ]);
  // A document that asks for more than one signature: staff see every field; the customer
  // the fields of the signature that is theirs to make next, none once theirs are in.
  const content = doc.kind === "offer" ? (doc.content as OfferContent | null) : null;
  const awaiting = doc.status === "signed" ? [] : awaitingSlots(content, all);
  const mine = customerSlot(awaiting);
  // A room member reads: nothing to fill in, nothing to confirm, no billing details.
  const reader = via === "room";
  const fields = reader
    ? []
    : via === "staff" || slotsOf(content).length === 1
      ? allFields
      : mine
        ? fieldsOf(allFields, mine)
        : [];
  // Placeholders for what the signer's fields provide; the organisation's own name when
  // the document has no organisation field, and no role when it has no role field.
  const [org, billing] = await Promise.all([
    store.org(d.db, doc.orgId),
    store.billing(d.db, doc.orgId),
  ]);
  const toTheCustomer = via === "staff" && doc.status === "sent" && doc.requiresSignature;
  // A room member sees who signed and when; the signer's address, VAT number and what
  // they filled in stay with those who run the account (the signed PDF stays readable).
  const readerSafe = (v: ReturnType<typeof signatureView>) =>
    reader ? { ...v, address: null, vat_number: null, values: {} } : v;
  const isEvent = (doc.content as OfferContent | null)?.template === "event";
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
      reminded.get(doc.id) ?? null,
      reader,
      mayNameSigner,
    ),
    body: doc.body,
    content: (doc.content ?? null) as OfferContent | null,
    lines: (doc.lines ?? null) as PricedLine[] | null,
    sha256: doc.sha256,
    page_count: doc.pageCount,
    fields: fields.map(fieldView),
    // The texts the document incorporates; an event offer has no SLA.
    legal: (
      [
        ["terms", terms],
        ["sla", sla],
        ["dpa", dpa],
      ] as const
    )
      .map(([kind, row]) =>
        legalView(
          kind,
          row,
          // Staff read the live pages; the customer side serves the pinned text.
          via === "staff" ? null : `${customerBase(doc.orgId)}/documents/${doc.id}/legal/${kind}`,
        ),
      )
      .filter((x) => x && (x.kind !== "sla" || !isEvent)),
    signing_note: doc.requiresSignature ? signingNote(doc) : null,
    // The sentence the signer confirms; the page fills in the three values it asks for.
    confirmation:
      doc.requiresSignature && !reader
        ? {
            dpa_authorised: confirmationText(doc, { ...placeholders, dpa_authorised: true }),
            dpa_not_authorised:
              doc.kind === "offer" && !(doc.content as OfferContent | null)?.dpa_separate
                ? confirmationText(doc, { ...placeholders, dpa_authorised: false })
                : null,
          }
        : null,
    signatures: all.map((x) => ({
      slot: x.slot as Slot,
      name: x.typedName,
      role: x.typedRole,
      email: x.email,
      signed_at: x.signedAt.toISOString(),
    })),
    awaiting_signatures: doc.requiresSignature && doc.status !== "draft" ? awaiting : [],
    signature: sig
      ? readerSafe(
          signatureView(
            sig,
            via === "staff" && sig.evidenceKey
              ? `${staffBase(doc.orgId)}/documents/${doc.id}/evidence`
              : undefined,
          ),
        )
      : null,
    prefill: reader
      ? { organisation: null, address: null, po_number: null }
      : signingPrefill(org?.name ?? null, billing, doc),
    access: via,
    staff_url:
      via === "staff" ? staffDocumentUrl(d.settings.dashboardUrl, doc.orgId, doc.id) : null,
    customer_links: toTheCustomer
      ? {
          sign_in: continueUrl(d.settings.dashboardUrl, doc.orgId),
          document: customerSignUrl(d.settings.dashboardUrl, doc.orgId, doc.id),
        }
      : null,
    customer_email: toTheCustomer && withEmail ? await customerEmailFor(d, doc, viewer) : null,
  };
}

/**
 * What the signer need not type: the organisation as it is billed (else its name) and the
 * billing address, when we have them, and the reference the offer carries. The billing PO
 * is never offered: it may be another order's. The signer still sees and may change each.
 */
function signingPrefill(orgName: string | null, b: BillingRow | null, doc: DocumentRow) {
  const language = doc.language;
  const place = [b?.billing_postal_code, b?.billing_city].filter(Boolean).join(" ");
  // The country reads in the document's language; details without a code keep what was typed.
  const country = b?.billing_country_code
    ? countryName(b.billing_country_code, language)
    : b?.billing_country;
  const address = [b?.billing_address_line1, b?.billing_address_line2, place, country]
    .filter(Boolean)
    .join(", ");
  return {
    organisation: b?.billing_legal_name || orgName || null,
    address: b?.billing_address_line1 ? address : null,
    po_number: (doc.content as OfferContent | null)?.customer_reference ?? null,
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
    throw new ConflictError("document.not_declinable");
  if (a.doc.signerEmail && a.doc.signerEmail.toLowerCase() !== a.email)
    throw new ForbiddenError("document.decline_signer_only", {
      params: { signer_email: a.doc.signerEmail },
    });
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
        (t.kind === "sign" || t.code === "who_signs") &&
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

/** Each naming sends an invitation, so ten an hour per organisation, like invite resends. */
const SIGNER_LIMIT = { name: "account_signer", capacity: 10, windowSeconds: 3600 };
/** A named signer is reminded at most once a day. */
const REMIND_LIMIT = { name: "account_signer_remind", capacity: 1, windowSeconds: 86_400 };

/**
 * Names someone else to sign. They get an email with a link; signing in with a code sent
 * to that address reaches this one document and nothing else of the organisation. They
 * also show among the members as invited, and the signing task waits on them: their
 * signature completes it. Naming a different person than the one already named goes on
 * the timeline as a replacement. Only owners and admins name or change the signer: someone
 * who is not a member is invited in, and bringing someone new in is theirs to do.
 */
export async function nameSigner(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  signer: Person,
) {
  const { org, role } = await customerOrgAs(d, who, orgId, "account:sign");
  // Before anything else, so a refusal costs none of the organisation's namings.
  assertMayNameSigner(role);
  return setSigner(d, who, org, docId, signer, {
    actor: { kind: "customer", userId: who.directusUserId },
    counted: true,
  });
}

/**
 * Names who signs a document that waits for a signature, or changes who it is: the one
 * function behind every way a signer is named (the customer's route, their answer to "who
 * signs", the staff route, an offer sent with its signer). Whoever calls it has decided
 * that the caller may; this checks the document. The person gets the signing email with a
 * link bound to them and this moment, so an earlier signer's link stops working; they are
 * invited into the organisation, so the sign-in step sends them a code. One signer per
 * document, and none once it is signed (409).
 *
 * `counted`: the naming counts against the organisation's own namings (SIGNER_LIMIT), as
 * the customer's do. `tx`: within a transaction already open, as a send is.
 */
export async function setSigner(
  d: AccountsDeps,
  who: Signed,
  org: { id: string; name: string },
  docId: string,
  signer: Person,
  how: { actor: Actor; counted?: boolean; tx?: Conn },
) {
  const doc = await awaitingSigner(how.tx ?? d.db, org.id, docId);
  const email = signer.email.trim().toLowerCase();
  // The person already named: their link stands and nobody is emailed again.
  const named = (x: DocumentRow) => Boolean(x.signerInvitedAt && isNamedSigner(x, email));
  // After the checks, so a refused naming costs the organisation none of its namings.
  if (how.counted && !named(doc)) await d.limiter.check(SIGNER_LIMIT, org.id);
  const now = d.now();
  let kept: DocumentRow | null = null;
  const write = async (tx: Conn) => {
    // Locked and read again, so a signature or another naming at the same moment either
    // lands first or waits, and who is named is decided on the row as it is now.
    const current = await lockAwaiting(tx, org.id, doc.id);
    if (named(current)) {
      kept = current;
      if (current.signerName !== signer.name || current.signerRole !== signer.role)
        await store.updateDocument(tx, doc.id, {
          signerName: signer.name,
          signerRole: signer.role,
          updatedAt: now,
        });
      return;
    }
    const replaced =
      current.signerEmail && current.signerEmail.toLowerCase() !== email
        ? { previous_email: current.signerEmail, previous_name: current.signerName }
        : null;
    await store.updateDocument(tx, doc.id, {
      signerEmail: email,
      signerName: signer.name,
      signerRole: signer.role,
      signerInvitedAt: now,
      updatedAt: now,
    });
    // Kept on the event, so taking them off later withdraws only what this naming made.
    const inviteId = await store.inviteToOrg(tx, {
      id: newId(),
      orgId: org.id,
      email,
      role: "billing",
      invitedBy: who.appUserId ?? null,
      now,
    });
    await emailSigner(d, tx, who, org, { ...current, signerEmail: email, signerInvitedAt: now });
    const withdrawn = replaced
      ? {
          withdrawn_invite_ids: await releaseSignerInvite(tx, org.id, replaced.previous_email, now),
        }
      : null;
    await emit(d, tx, {
      orgId: org.id,
      actor: how.actor,
      type: replaced ? "document.signer_replaced" : "document.signer_named",
      subject: { type: "document", id: doc.id },
      detail: { email, name: signer.name, ...replaced, invite_id: inviteId, ...withdrawn },
    });
  };
  if (how.tx) await write(how.tx);
  else await d.db.transaction(write);
  const was = kept as DocumentRow | null;
  return {
    signer: {
      email,
      name: signer.name,
      named_at: (was?.signerInvitedAt ?? now).toISOString(),
      reminded_at: null,
      role: signer.role,
    },
  };
}

/**
 * Someone no longer named to sign, or taken out of the room: the invitations their namings
 * made (each naming keeps its invitation's id on its event) are withdrawn, unless a document
 * of the organisation still waits on them or the room still gives them access. Invitations
 * made another way (the Members page, the room) were never on a naming's event, so they
 * stay, and one already taken up stays a membership. Returns the ids withdrawn, for the
 * event that records the change. The one place that decides it: setSigner, unsetSigner and
 * removeRoomPerson call it. invitationHeld says which invitations it and the room may
 * withdraw, so the Members page can replace them with its own.
 */
export async function releaseSignerInvite(
  tx: Conn,
  orgId: string,
  email: string,
  now: Date,
): Promise<string[]> {
  if ((await store.waitingForSigner(tx, email)).some((x) => x.orgId === orgId)) return [];
  if ((await store.roomPersonByEmail(tx, orgId, email))?.accessGrantedAt) return [];
  const withdrawn: string[] = [];
  for (const id of await store.signerInviteIds(tx, orgId, email))
    if (await store.withdrawOrgInvite(tx, id, now)) withdrawn.push(id);
  return withdrawn;
}

/**
 * Whether a pending invitation is one this package made and may withdraw later: a naming's
 * (releaseSignerInvite reads the same ids) or the room's (removeRoomPerson withdraws the
 * row's). The Members page asks it before answering "already invited": an owner or admin
 * inviting such an address replaces the invitation with one of their own, which neither a
 * change of signer nor a removal from the room withdraws.
 */
export async function invitationHeld(
  c: Conn,
  orgId: string,
  email: string,
  inviteId: string,
): Promise<boolean> {
  if ((await store.signerInviteIds(c, orgId, email)).includes(inviteId)) return true;
  return (await store.roomPersonByEmail(c, orgId, email))?.orgInviteId === inviteId;
}

/**
 * Takes the naming off a document that waits for a signature: nobody is named, so whoever
 * runs the account signs it, and the link sent to the person named stops working (it is
 * bound to the naming). The other half of setSigner, and like it, the caller has decided
 * that the caller may. Nobody named: nothing changes.
 */
export async function unsetSigner(
  d: AccountsDeps,
  org: { id: string },
  docId: string,
  how: { actor: Actor; tx?: Conn },
) {
  const doc = await awaitingSigner(how.tx ?? d.db, org.id, docId);
  if (!doc.signerEmail) return;
  const now = d.now();
  const write = async (tx: Conn) => {
    await lockAwaiting(tx, org.id, doc.id);
    await store.updateDocument(tx, doc.id, {
      signerEmail: null,
      signerName: null,
      signerRole: null,
      signerInvitedAt: null,
      updatedAt: now,
    });
    const withdrawn = await releaseSignerInvite(tx, org.id, doc.signerEmail as string, now);
    await emit(d, tx, {
      orgId: org.id,
      actor: how.actor,
      type: "document.signer_removed",
      subject: { type: "document", id: doc.id },
      detail: {
        previous_email: doc.signerEmail,
        previous_name: doc.signerName,
        withdrawn_invite_ids: withdrawn,
      },
    });
  };
  if (how.tx) await write(how.tx);
  else await d.db.transaction(write);
}

/** Whether `email` is the person named to sign `doc`. */
export const isNamedSigner = (doc: Pick<DocumentRow, "signerEmail">, email: string | null) =>
  Boolean(email && doc.signerEmail?.toLowerCase() === email.trim().toLowerCase());

/** A document a signer may be named on or taken off: sent, waiting for a signature. */
async function awaitingSigner(c: Conn, orgId: string, docId: string) {
  const doc = isUuid(docId) ? await store.document(c, orgId, docId) : null;
  if (!doc || doc.status === "draft") throw new NotFoundError("document.not_found");
  if (!doc.requiresSignature || !["sent", "viewed"].includes(doc.status))
    throw new ConflictError("document.not_awaiting_signature");
  return doc;
}

/** Locks it as it is written, so a signature at the same moment lands first or waits. */
async function lockAwaiting(tx: Conn, orgId: string, docId: string) {
  const locked = await store.documentForUpdate(tx, orgId, docId);
  if (!locked?.requiresSignature || !["sent", "viewed"].includes(locked.status))
    throw new ConflictError("document.not_awaiting_signature");
  return locked;
}

/**
 * Sends the named signer their link again. The link stays the one they already have, and
 * the wait keeps counting from when they were named.
 */
export async function remindSigner(d: AccountsDeps, who: Signed, orgId: string, docId: string) {
  const org = await customerOrg(d, who, orgId, "account:sign");
  const doc = await store.document(d.db, org.id, docId);
  if (!doc || doc.status === "draft") throw new NotFoundError("document.not_found");
  // Without a named signer there is no one to remind: the admins sign it themselves.
  if (
    !doc.requiresSignature ||
    !["sent", "viewed"].includes(doc.status) ||
    !doc.signerEmail ||
    !doc.signerInvitedAt
  )
    throw new ConflictError("document.not_awaiting_signature");
  await d.limiter.check(REMIND_LIMIT, doc.id);
  await d.limiter.check(SIGNER_LIMIT, org.id);
  const email = doc.signerEmail;
  await d.db.transaction(async (tx) => {
    await emailSigner(d, tx, who, org, doc);
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "document.signer_reminded",
      subject: { type: "document", id: doc.id },
      detail: { email },
    });
  });
  return {
    signer: {
      email,
      name: doc.signerName,
      named_at: doc.signerInvitedAt.toISOString(),
      reminded_at: d.now().toISOString(),
      role: doc.signerRole,
    },
  };
}

/** The invitation to sign, with the link for the person and naming the document carries. */
async function emailSigner(
  d: AccountsDeps,
  tx: Conn,
  who: Signed,
  org: { name: string },
  doc: DocumentRow,
) {
  const email = doc.signerEmail ?? "";
  const me = await store.identity(tx, who.directusUserId);
  // The signer's own language when they have an account, else the document's.
  const language =
    (await localeOfEmail(tx, email).catch(() => null)) ?? resolveLocale(doc.language);
  await d.jobs.enqueue(
    sendEmail,
    {
      language,
      to: email,
      subject: `Please sign ${doc.title}`,
      template: "account_signer_invite",
      data: {
        inviter_name: me?.name || me?.email || org.name,
        org_name: org.name,
        document_title: doc.title,
        // Opens the invitation page for this person, not a bare sign-in.
        sign_url: signerInviteUrl(d.settings.dashboardUrl, d.settings.inviteSecret, doc),
      },
      context: `account signer invite ${doc.id}`,
    },
    { tx },
  );
}

/** Someone named to sign, as staff and customers give them. */
export type Person = { name: string; email: string; role: string | null };

/** The DPA an offer went out with: the one pinning the same DPA text, in one of `statuses`. */
export function dpaOf(
  docs: readonly DocumentRow[],
  offer: DocumentRow,
  statuses: readonly string[],
): DocumentRow | null {
  return (
    docs.find(
      (x) => x.kind === "dpa" && x.dpaTextId === offer.dpaTextId && statuses.includes(x.status),
    ) ?? null
  );
}

/**
 * The answers to "who signs": who signs the offer (null: the person answering), whether the
 * same person signs the DPA, else who does (null: the person answering), and whether they
 * want their own DPIA. The DPA is its own document, sent with the offer (openDpa); the
 * answers only say whose each signature is. Asked once per offer, before signing; changing
 * it later goes through a question to us.
 *
 * The answer is made true: someone else is named, or, for "I sign" while someone else is
 * named (staff may name the signer when sending), that naming is taken off. An answer that
 * changes who signs is for owners and admins: from Billing it is refused whole, before
 * anything is applied. Answering with the person named already, or "I sign" with nobody
 * named, changes nothing, so Billing may give it, and nobody is emailed again.
 */
export async function answerWhoSigns(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  taskId: string,
  input: {
    offer_signer: Person | null;
    dpa_same: boolean;
    dpa_signer: Person | null;
    dpia: boolean;
  },
) {
  const { org, role } = await customerOrgAs(d, who, orgId, "account:sign");
  const dpaSigner = input.dpa_same ? input.offer_signer : input.dpa_signer;
  // Naming someone in an answer is for owners and admins, as before; naming the person
  // named already changes nothing and is checked below, with the documents.
  const names = (doc: DocumentRow | null, p: Person | null) =>
    p && !(doc && isNamedSigner(doc, p.email));
  const task = await store.task(d.db, org.id, taskId);
  if (task?.code !== "who_signs") throw new NotFoundError("task.not_found");
  if (!["open", "changes_requested"].includes(task.status))
    throw new ConflictError("task.not_waiting");
  const offer = task.documentId ? await store.document(d.db, org.id, task.documentId) : null;
  if (!offer || !["sent", "viewed"].includes(offer.status))
    throw new ConflictError("document.not_awaiting_signature");
  // The DPA the offer went out with, while it still waits on a signature.
  const dpa = dpaOf(await store.documents(d.db, org.id), offer, ["sent", "viewed"]);
  const me = await store.identity(d.db, who.directusUserId);
  const myEmail = me?.email ?? null;
  // "I sign" while someone else is named takes their naming off.
  const unnames = (doc: DocumentRow | null, p: Person | null) =>
    !p && doc !== null && doc.signerEmail !== null && !isNamedSigner(doc, myEmail);
  // Refused whole, before anything is applied: also when the DPA no longer waits, and the
  // person would only be named in the answer.
  if (
    names(offer, input.offer_signer) ||
    names(dpa, dpaSigner) ||
    unnames(offer, input.offer_signer) ||
    unnames(dpa, dpaSigner)
  )
    assertMayNameSigner(role);
  const self = me?.name ? `${me.name} (${me.email})` : (me?.email ?? "the person answering");
  const person = (p: Person | null) =>
    p ? `${p.name} (${p.email}${p.role ? `, ${p.role}` : ""})` : self;
  /** Whom the answer replaces on a document, for the stored answer. */
  const replaces = (doc: DocumentRow | null, p: Person | null) =>
    doc?.signerEmail && (names(doc, p) || unnames(doc, p))
      ? `, in place of ${doc.signerName ? `${doc.signerName} (${doc.signerEmail})` : doc.signerEmail}`
      : "";
  const offerWas = replaces(offer, input.offer_signer);
  const dpaWas = replaces(dpa, dpaSigner);

  // Each change stands on its own, so answering again after a failure picks up where it
  // stopped: the person named already is not named, or emailed, again.
  const actor = { kind: "customer" as const, userId: who.directusUserId };
  if (input.offer_signer && names(offer, input.offer_signer))
    await nameSigner(d, who, org.id, offer.id, input.offer_signer);
  else if (unnames(offer, input.offer_signer)) await unsetSigner(d, org, offer.id, { actor });
  if (dpa && dpaSigner && names(dpa, dpaSigner))
    await nameSigner(d, who, org.id, dpa.id, dpaSigner);
  else if (dpa && unnames(dpa, dpaSigner)) await unsetSigner(d, org, dpa.id, { actor });

  const summary = [
    `Offer: signed by ${person(input.offer_signer)}${offerWas}.`,
    `Data processing agreement: signed by ${
      input.dpa_same ? "the same person" : person(input.dpa_signer)
    }${dpaWas}.`,
    input.dpia
      ? "They want their own data protection impact assessment (DPIA)."
      : "No DPIA of their own.",
  ].join("\n");
  await d.db.transaction(async (tx) => {
    await settleTask(d, tx, task.id, "done", {
      params: {
        ...((task.params ?? {}) as Record<string, string>),
        dpa_same: input.dpa_same ? "true" : "false",
        dpia: input.dpia ? "true" : "false",
      },
      responseText: summary,
      submittedAt: d.now(),
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
      // sam reads the answers, and follows up on a DPIA, from the task's response.
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
  if (!blob) throw new NotFoundError("document.no_pdf");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The signed PDF, once signed: the copy the last signature made, which carries every
 * signature of a document that asked for more than one.
 */
export async function signedBytes(d: AccountsDeps, doc: DocumentRow): Promise<Uint8Array> {
  const done = doc.status !== "sent" && doc.status !== "viewed";
  const all = done ? await store.signaturesOf(d.db, doc.id) : [];
  // dembrane's signature applied when sending is not a signed copy of its own.
  const sig = all.some((x) => x.slot === "customer") ? all.at(-1) : null;
  const blob = sig ? await d.files.get(sig.signedPdfKey) : null;
  if (!blob) throw new NotFoundError("document.not_signed");
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

/**
 * One of the legal documents a document incorporates, as a page to read: the version it
 * pinned when it was sent, not the one on the website today. Open to everyone who may read
 * the document, including the person named to sign it.
 */
export async function customerLegalText(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  kind: string,
) {
  const a = await documentFor(d, who, orgId, docId, "account:read");
  const pinned = { terms: a.doc.termsTextId, sla: a.doc.slaTextId, dpa: a.doc.dpaTextId };
  const id = kind === "terms" || kind === "sla" || kind === "dpa" ? pinned[kind] : null;
  const row = id ? await store.legalById(d.db, id) : null;
  if (!row) throw new NotFoundError("document.not_found");
  return legalTextPage(row, a.doc.reference ?? a.doc.title, a.doc.language);
}

// ── billing details ─────────────────────────────────────────────────────

export interface BillingInput {
  readonly legal_name: string;
  readonly billing_email: string;
  readonly address_line1: string;
  readonly address_line2: string | null;
  readonly postal_code: string;
  readonly city: string;
  readonly country_code: string | null;
  readonly country: string | null;
  readonly vat_id: string | null;
  readonly no_vat_number?: boolean | null | undefined;
  readonly kvk_number: string | null;
  readonly kbo_number: string | null;
  readonly po_number: string | null;
  readonly peppol_id: string | null;
  readonly invoice_delivery?: Delivery | null | undefined;
  readonly invoice_portal: string | null;
}

/** The Peppol directory entry for numbers the customer is typing, before they save. */
export async function peppolLookup(d: AccountsDeps, who: Signed, orgId: string, ids: TaxIds) {
  await customerOrg(d, who, orgId, "account:billing");
  return { match: await lookupPeppol(d, ids) };
}

export async function readBilling(d: AccountsDeps, who: Signed, orgId: string) {
  const org = await customerOrg(d, who, orgId, "account:billing");
  return billingView(await store.billing(d.db, org.id));
}

/**
 * Saves what Exact needs to invoice, on the organisation's own billing account (made if it
 * has none yet), and completes the billing details task: no review by us. The country
 * decides which numbers are asked and how they must look (billing-rules.ts, the rules the
 * form checks too); numbers are stored cleaned. Formats only: nothing is looked up to
 * confirm a number is real, and no tax is decided here. A customer that gets invoices
 * neither by email nor through Peppol writes how instead, and that opens a question.
 */
export async function updateBilling(d: AccountsDeps, who: Signed, orgId: string, b: BillingInput) {
  const org = await customerOrg(d, who, orgId, "account:billing");
  const country = countryCodeOf(b.country_code ?? b.country);
  const { problems, clean } = checkBilling({ ...b, country_code: country });
  if (!country || problems.length)
    throw fieldErrors(
      problems.map((p) => ({
        field: p.field,
        code: p.kind === "missing" ? "field.required" : "field.invalid",
      })),
    );
  const now = d.now();
  const me = await store.identity(d.db, who.directusUserId);
  // A Peppol id typed by the customer wins; otherwise the directory is asked, outside the
  // transaction so a slow directory holds no lock.
  const match = clean.peppol_id ? null : await lookupPeppol(d, clean);
  const locale = me?.email ? await localeOfEmail(d.db, me.email).catch(() => null) : null;
  await d.db.transaction(async (tx) => {
    await store.lockOrg(tx, org.id);
    const patch = {
      billing_legal_name: b.legal_name,
      billing_email: b.billing_email.trim().toLowerCase(),
      billing_address_line1: b.address_line1,
      billing_address_line2: b.address_line2,
      billing_postal_code: b.postal_code,
      billing_city: b.city,
      // The name is what reads on an invoice; the code is what a program should read.
      billing_country: countryName(country),
      billing_country_code: country,
      billing_vat_id: clean.vat_id,
      no_vat_number: clean.no_vat_number,
      kvk_number: clean.kvk_number,
      kbo_number: clean.kbo_number,
      po_number: b.po_number,
      peppol_id: clean.peppol_id ?? match?.participant_id ?? null,
      peppol_name: clean.peppol_id ? null : (match?.name ?? null),
      ...(b.invoice_delivery !== undefined
        ? { invoice_delivery: b.invoice_delivery, invoice_portal: clean.invoice_portal }
        : {}),
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
    // Another way than email or Peppol is agreed between people: what the customer wrote
    // goes to dembrane as a question of theirs. Once per text, so saving again asks nothing new.
    const wrote = b.invoice_delivery === "other" ? clean.invoice_portal : null;
    if (wrote && !(account?.invoice_delivery === "other" && account.invoice_portal === wrote))
      await insertQuestion(d, tx, org, who, me?.email ?? null, {
        subject: translator(locale)("ticket.invoice_delivery.subject"),
        body: wrote,
      });
    // With an offer already signed, these details are the last thing the invoice waited for.
    await requestInvoices(d, tx, org);
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
  if (!task) throw new NotFoundError("task.not_found");
  if (task.kind === "sign") throw new ConflictError("task.done_by_signing");
  if (task.kind === "billing_details") throw new ConflictError("task.done_by_billing_details");
  // An onboarding step is done by taking it (opening the demo, creating a project), never
  // by a reply that staff would then have to review.
  if (isOnboardingCode(task.code)) throw new ConflictError("task.not_waiting");
  // Who signs is answered in its own form, which names the signers.
  if (task.code === "who_signs") throw new ConflictError("task.not_waiting");
  if (!["open", "changes_requested"].includes(task.status))
    throw new ConflictError(task.status === "locked" ? "task.not_open" : "task.not_waiting");
  if (task.kind === "upload" && !input.file) throw new ValidationError("task.file_required");
  if (!input.text && !input.file) throw new ValidationError("task.reply_required");
  if (input.file && input.file.bytes.byteLength > MAX_TASK_FILE_BYTES)
    throw new ValidationError("upload.too_large", { params: { max_mb: 20 } });
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
  const me = await store.identity(d.db, who.directusUserId);
  const id = await d.db.transaction((tx) =>
    insertQuestion(d, tx, org, who, me?.email ?? null, input),
  );
  return ticketOf(d, org.id, id);
}

/**
 * A customer's question to dembrane with its first message, told to sam and Slack. The one
 * way a question starts, whichever screen it was written on.
 */
async function insertQuestion(
  d: AccountsDeps,
  tx: Tx,
  org: Awaited<ReturnType<typeof customerOrg>>,
  who: Signed,
  email: string | null,
  input: { subject: string; body: string },
): Promise<string> {
  const now = d.now();
  const id = newId();
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
      opened_by: email,
    },
    slack: `:speech_balloon: New question from ${org.name} (${email ?? "a member"}): ${input.subject}`,
  });
  return id;
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
  if (!ticket) throw new NotFoundError("question.not_found");
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
  if (!ticket) throw new NotFoundError("question.not_found");
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
      webhook: {
        event: "account.call.booked",
        org: orgPayload(org),
        booking: { uid: booking.uid, start: booking.start, status: booking.status },
      },
    });
  });
  // After the booking commits, and never failing it: the call matters, not the checkbox.
  await completeOnboarding(d, org.id, "book_call");
  return { recorded: true };
}

/**
 * "Watch the tutorial": the tutorial link was clicked from the task. No one can tell a
 * video was watched, so the click is the step. Twice is the same as once.
 */
export async function recordTutorialOpened(d: AccountsDeps, who: Signed, orgId: string) {
  const org = await customerOrg(d, who, orgId, "account:tasks");
  await completeOnboarding(d, org.id, "watch_tutorial");
  return { recorded: true as const };
}

const DOCUMENT_KINDS = ["offer", "dpa", "invoice", "other"] as const;
const isDocumentKind = (v: unknown): v is (typeof DOCUMENT_KINDS)[number] =>
  typeof v === "string" && (DOCUMENT_KINDS as readonly string[]).includes(v);

/**
 * Every organisation whose account the caller runs, with task counts and the next task:
 * the "Tasks 1/2" entry and the org picker; then those where the caller is a member with
 * room access, marked so, counting only what a room member reads and with nothing waiting
 * on them. Two indexed queries; cheap on every page load.
 */
export async function tasksSummary(d: AccountsDeps, who: Signed) {
  if (!who.appUserId) return [];
  const [rows, roomRows] = await Promise.all([
    store.tasksSummary(d.db, who.appUserId, ACCOUNT_ROLES),
    verifiedEmail(d, who).then((email) =>
      store.roomTasksSummary(d.db, who.appUserId as string, email, ACCOUNT_ROLES),
    ),
  ]);
  const room = roomRows.map((r) => ({
    ...r,
    access: "room" as const,
    account_stage: r.account_stage as "prospect" | "customer" | "churned" | null,
    tasks_waiting: 0,
    next_task_title: null,
    next_task_code: null,
    next_task_params: null,
    next_task_document_id: null,
    next_task_document_kind: null,
  }));
  const account = rows.map(({ next_task, ...r }) => ({
    ...r,
    access: "account" as const,
    account_stage: r.account_stage as "prospect" | "customer" | "churned" | null,
    next_task_title: next_task?.code ? null : (next_task?.title ?? null),
    next_task_code: isTaskCode(next_task?.code) ? next_task.code : null,
    next_task_params: next_task?.code ? ((next_task.params ?? {}) as Record<string, string>) : null,
    next_task_document_id: next_task?.document_id ?? null,
    next_task_document_kind: isDocumentKind(next_task?.document_kind)
      ? next_task.document_kind
      : null,
  }));
  return [...account, ...room].sort((a, b) => a.name.localeCompare(b.name));
}
