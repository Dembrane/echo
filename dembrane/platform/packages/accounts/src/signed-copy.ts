import { sendEmail } from "@dembrane/account";
import type { AccountsDeps, Conn } from "./deps";
import { customerSignUrl } from "./invoice";
import { accountRecipients } from "./recipients";
import type { DocumentRow, OrgRow } from "./storage";

/**
 * A signed PDF up to this size travels with the email. Mail providers refuse messages near
 * 30 MB and base64 adds a third, so larger copies are linked instead.
 */
export const MAX_ATTACHED_BYTES = 8 * 1024 * 1024;

export interface SignedCopy {
  readonly signerName: string;
  readonly signerEmail: string;
  readonly signedAt: string;
  readonly pdfKey: string;
  readonly pdfSha256: string;
  readonly pdfBytes: number;
}

/**
 * After a signature: the signer and the people who run the account (owners and admins) each
 * get one email with the signing details and the signed PDF, in the document's language.
 * The customer's own act sets it off, and it is queued in the signing transaction, so it
 * exists only if the signature does. An address that is both signer and admin gets one.
 * Returns the addresses written to, for the document's timeline.
 */
export async function emailSignedCopy(
  d: AccountsDeps,
  tx: Conn,
  org: OrgRow,
  doc: DocumentRow,
  copy: SignedCopy,
): Promise<string[]> {
  const admins = await accountRecipients(tx, org.id, ["owner", "admin"]);
  const addresses = new Map<string, string>();
  for (const email of [copy.signerEmail, ...admins.map((a) => a.email)])
    if (!addresses.has(email.trim().toLowerCase()))
      addresses.set(email.trim().toLowerCase(), email);
  const attached = copy.pdfBytes <= MAX_ATTACHED_BYTES;
  const language = doc.language === "nl" ? "nl" : "en";
  const filename = `${doc.title.replace(/[^A-Za-z0-9._ -]+/g, "_")} (signed).pdf`;
  for (const [address, email] of addresses)
    await d.jobs.enqueue(
      sendEmail,
      {
        to: email,
        language,
        subject: `${doc.title} is signed`,
        template: "account_signed_copy",
        data: {
          org_name: org.name,
          document_title: doc.title,
          ...(doc.reference && { reference: doc.reference }),
          signer_name: copy.signerName,
          signer_email: copy.signerEmail,
          signed_at: copy.signedAt,
          document_id: doc.id,
          sha256: copy.pdfSha256,
          attached: attached ? "yes" : "no",
          document_url: customerSignUrl(d.settings.dashboardUrl, org.id, doc.id),
        },
        ...(attached && {
          attachments: [{ key: copy.pdfKey, filename, content_type: "application/pdf" }],
        }),
        context: `account signed copy ${doc.id}`,
      },
      { tx, workflowId: `accounts.signed-copy:${doc.id}:${address}` },
    );
  return [...addresses.values()];
}
