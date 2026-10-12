/**
 * Renders every email the platform sends, in English and Dutch, with sample data, to one
 * folder: <name>.<locale>.html and .txt, plus an index.html that shows them side by side.
 * For reviewing copy and design without sending anything.
 *
 *   bun scripts/email-previews.ts [outdir]   (default: ./email-previews)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type EmailTemplate, render, subjectOf } from "../packages/account/src/emails";
import {
  paymentFailedEmail,
  tierExpiredEmail,
  tierExpiringSoonEmail,
} from "../packages/billing/src/emails";
import { supportEmail } from "../packages/staff/src/emails";
import {
  orgInviteEmail,
  supportAccessEmail,
  tierDowngradedEmail,
  workspaceInviteEmail,
} from "../packages/tenancy/src/emails";

const out = path.resolve(process.argv[2] ?? "email-previews");
const LOCALES = ["en-US", "nl-NL"] as const;
const D = "https://dashboard.dembrane.com";
const offer = {
  org_name: "Gemeente Utrecht",
  document_title: "Gemeente Utrecht x dembrane 2027",
  sign_url: `${D}/o/1/account/documents/2/sign`,
};

type Preview = (locale: string) => { subject: string; html: string; text: string };
const catalog =
  (t: EmailTemplate): Preview =>
  (locale) => ({
    subject: subjectOf(t, locale) ?? "",
    ...render(t, locale),
  });

/** The call-to-cash flow first, in the order a customer meets them. */
const previews: Record<string, Preview> = {
  account_invite: catalog({
    template: "account_invite",
    data: { org_name: offer.org_name, sign_in_url: `${D}/o/1/account` },
  }),
  account_offer_sent: catalog({
    template: "account_offer_sent",
    data: {
      ...offer,
      reference: "OFF-2026-014",
      total_cents: "1210000",
      currency: "EUR",
      valid_until: "2026-12-01",
      manager_name: "Anna de Vries",
    },
  }),
  account_signer_invite: catalog({
    template: "account_signer_invite",
    data: { ...offer, inviter_name: "Bram Jansen" },
  }),
  account_document_withdrawn: catalog({
    template: "account_document_withdrawn",
    data: {
      org_name: offer.org_name,
      account_url: `${D}/o/1/account`,
      document_title: offer.document_title,
      manager_name: "Anna de Vries",
      note: "A corrected offer with the new start date follows this week.",
    },
  }),
  account_task_reminder: catalog({
    template: "account_task_reminder",
    data: {
      org_name: offer.org_name,
      account_url: `${D}/o/1/account`,
      task_title: "Billing details",
      task_body:
        "Who we invoice: legal name, address, VAT or KvK number, billing email and, if you use one, your PO number.",
      manager_name: "Anna de Vries",
    },
  }),
  sign_in_code: catalog({ template: "sign_in_code", data: { code: "482913" } }),
  payment_failed: (l) => paymentFailedEmail(`${D}/o/1/settings/billing`, l),
  tier_expiring: (l) =>
    tierExpiringSoonEmail(
      {
        workspaceName: "Participatie 2027",
        currentTier: "Pro",
        expiresDate: "1 November 2026",
        workspaceUrl: `${D}/w/1/settings/billing`,
      },
      l,
    ),
  tier_expired: (l) =>
    tierExpiredEmail(
      {
        workspaceName: "Participatie 2027",
        fromTier: "Pro",
        freezeItems: ["Freeze API access (existing tokens keep working; no new tokens)"],
        revertItems: ["Remove your custom logo (revert to dembrane logo)"],
        workspaceUrl: `${D}/w/1/settings/billing`,
      },
      l,
    ),
  tier_downgraded: (l) =>
    tierDowngradedEmail(
      {
        workspaceName: "Participatie 2027",
        fromTier: "Pro",
        toTier: "free",
        downgradedAtHuman: "12 October 2026",
        freezeItems: ["Freeze data export (existing files stay; new exports blocked)"],
        revertItems: [],
        workspaceUrl: `${D}/w/1`,
      },
      l,
    ),
  org_invite: (l) =>
    orgInviteEmail(
      { inviterName: "Bram Jansen", orgName: "Gemeente Utrecht", role: "admin", inviteUrl: D },
      l,
    ),
  workspace_invite: (l) =>
    workspaceInviteEmail(
      { inviterName: "Bram Jansen", workspaceName: "Participatie 2027", inviteUrl: D },
      l,
    ),
  verify_email: catalog({ template: "verify_email", data: { verify_url: `${D}/verify?t=x` } }),
  reset_password: catalog({ template: "reset_password", data: { reset_url: `${D}/reset?t=x` } }),
  report_published: catalog({
    template: "report_published",
    data: {
      portal_url: "https://portal.dembrane.com",
      project_id: "p1",
      token: "t",
      conversation_name: "Wijkgesprek Overvecht",
    },
  }),
  support_request: (l) =>
    supportAccessEmail(
      "Participatie 2027",
      { kind: "request", staffName: "Sameer", note: "", settingsUrl: D },
      l,
    ),
  staff_support_joined: (l) =>
    supportEmail(
      "support_access_joined",
      { workspace_name: "Participatie 2027", staff_name: "Sameer", settings_url: D },
      l,
    ),
};

mkdirSync(out, { recursive: true });
const rows: string[] = [];
for (const [name, make] of Object.entries(previews)) {
  const cells: string[] = [];
  for (const locale of LOCALES) {
    const r = make(locale);
    const file = `${name}.${locale}`;
    writeFileSync(path.join(out, `${file}.html`), r.html);
    writeFileSync(path.join(out, `${file}.txt`), `Subject: ${r.subject}\n\n${r.text}`);
    cells.push(
      `<td><p><b>${locale}</b> · ${r.subject.replace(/</g, "&lt;")}</p><iframe src="${file}.html"></iframe></td>`,
    );
  }
  rows.push(`<tr><th colspan="2">${name}</th></tr><tr>${cells.join("")}</tr>`);
}
writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Email previews</title><style>body{font-family:system-ui;margin:24px}th{text-align:left;padding-top:32px}iframe{width:640px;height:900px;border:1px solid #ddd}</style><table>${rows.join("")}</table>`,
);
process.stdout.write(
  `${Object.keys(previews).length} emails x ${LOCALES.length} languages in ${out}\n`,
);
