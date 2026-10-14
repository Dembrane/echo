import type { Signed } from "@dembrane/http";
import { translator } from "@dembrane/i18n";
import { email as e } from "@dembrane/mail";
import type { AccountsDeps } from "./deps";
import { accountManagerPayload } from "./events";
import { customerSignUrl } from "./invoice";
import { continueUrl } from "./prospect";
import { type DocumentRow, store } from "./storage";

/** The email the deal owner sends a customer when an offer is placed in their account. */
export interface CustomerEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

const firstWord = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] ?? "";

/**
 * The email to send the account's contact for a sent offer, worded in the offer's language
 * so the staff page and any API caller get the same text. dembrane sends nothing: a person
 * copies this into their own mail. It goes to the person who has run the account longest
 * and has an address; null when nobody does, since there is then no one to address.
 *
 * Signed with the first name of the staff member asking. A staff API key is not a person
 * who writes to the customer, so it signs with the account manager's, else "dembrane".
 */
export async function customerEmailFor(
  d: AccountsDeps,
  doc: DocumentRow,
  viewer: Signed | null,
): Promise<CustomerEmail | null> {
  const [contact] = (await store.accountPeople(d.db, doc.orgId)).filter((p) => p.email);
  if (!contact?.email) return null;
  const tr = translator(doc.language);

  let sender = "";
  if (viewer && !viewer.staffPolicies)
    sender = firstWord((await store.identity(d.db, viewer.directusUserId))?.name);
  if (!sender) sender = firstWord((await accountManagerPayload(d.db, doc.orgId))?.name);

  const offer = doc.reference ? `"${doc.title}" (${doc.reference})` : `"${doc.title}"`;
  const name = contact.name?.trim();
  const paragraphs = [
    name ? tr("offer_email.greeting", { name }) : tr("offer_email.greeting_plain"),
    `${tr("offer_email.ready", { offer })}\n${customerSignUrl(d.settings.dashboardUrl, doc.orgId, doc.id)}`,
    `${tr("offer_email.sign_in")}\n${continueUrl(d.settings.dashboardUrl, doc.orgId)}`,
    doc.validUntil
      ? tr("offer_email.valid_until", { date: e.day(doc.validUntil, doc.language) })
      : null,
    `${tr("offer_email.closing")}\n${sender || "dembrane"}`,
  ];
  return {
    to: contact.email,
    subject: tr("offer_email.subject", { document_title: doc.title }),
    body: paragraphs.filter((p) => p !== null).join("\n\n"),
  };
}
