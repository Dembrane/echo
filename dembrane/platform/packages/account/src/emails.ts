/**
 * Transactional emails of the account area, ported from the Jinja templates in the Python
 * API's email_templates with the same layout. Every sentence comes from the server catalog
 * (@dembrane/i18n, packages/i18n/locales) in the recipient's language; English renders
 * byte for byte as the old templates did. HTML values are escaped the way Jinja's
 * autoescape did; the text part is sent alongside every HTML part.
 */
import { type Translate, translator } from "@dembrane/i18n";

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const esc = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");

const P = (size: number, margin: string, body: string) =>
  `<p style="font-size:${size}px; line-height:1.65; margin:${margin}; color:#2D2D2C; font-weight:400;">\n  ${body}\n</p>`;

const em = (v: string) => `<em style="color:#4169E1; font-style:normal;">${esc(v)}</em>`;

function cta(label: string, url: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;">
  <tr>
    <td>
      <a href="${esc(url)}"
         style="display:inline-block; background-color:#4169E1; color:#FFFFFF; text-decoration:none; padding:14px 30px; border-radius:9999px; font-size:15px; font-weight:400; font-family:inherit; line-height:1;">
        ${esc(label)}
      </a>
    </td>
  </tr>
</table>`;
}

function fallback(tr: Translate, url: string): string {
  return `<p style="font-size:13px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight: 400;">
  ${tr("email.common.fallback")}<br>
  <span style="color:#4169E1; word-break:break-all;">${esc(url)}</span>
</p>`;
}

/** The shared frame: letter-style card, logo, heading, body, sign-off and banner. */
function layout(
  tr: Translate,
  b: {
    title: string;
    preview: string;
    heading: string;
    body: string;
    cta?: string;
    fallback?: string;
    disclaim?: string;
  },
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${b.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&display=swap');
  </style>
</head>
<body style="margin:0; padding:0; background-color:#F6F4F1; font-family:'DM Sans','DM Sans Variable',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; color:#2D2D2C; font-weight: 400;">
  <div style="display:none; font-size:1px; color:#F6F4F1; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
    ${b.preview}
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#F6F4F1; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px; background-color:#FFFFFF; border:1px solid #EFEAE2;">
          <tr>
            <td style="padding:32px 48px 0;">
              <img src="https://dashboard.echo-next.dembrane.com/dembrane-logo-email.png" alt="dembrane" width="147" height="30" border="0" style="height:30px; width:auto; max-width:100%; display:block; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic;">
            </td>
          </tr>
          <tr>
            <td style="padding:28px 48px 0;">
              <h1 style="margin:0 0 20px; font-family:inherit; font-size:32px; font-weight: 400; letter-spacing:-0.01em; line-height:1.15; color:#2D2D2C; text-wrap:balance;">
                ${b.heading}
              </h1>
              <div style="font-size:17px; line-height:1.65; color:#2D2D2C; font-weight: 400;">
                ${b.body}
              </div>
              ${b.cta ?? ""}
              ${b.fallback ?? ""}
              ${b.disclaim ?? ""}
              <p style="font-size:17px; line-height:1.65; margin:0 0 32px; color:#2D2D2C; font-weight: 400;">
                ${tr("email.common.signoff")}
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#FFFFFF;">
              <img src="https://directus.dembrane.com/assets/a75db1e0-4dd9-4660-a6fb-24e0dd4cd104" alt="" width="600" border="0" style="width:100%; max-width:600px; height:auto; display:block; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic;">
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export type EmailTemplate =
  | {
      readonly template: "workspace_invite";
      readonly data: { inviter_name: string; workspace_name: string; invite_url: string };
    }
  | {
      readonly template: "workspace_added";
      readonly data: { inviter_name: string; workspace_name: string; invite_url: string };
    }
  | {
      readonly template: "org_invite";
      readonly data: { inviter_name: string; org_name: string; role: string; invite_url: string };
    }
  | {
      readonly template: "registration_existing_account";
      readonly data: { login_url: string; reset_url: string };
    }
  | { readonly template: "verify_email"; readonly data: { verify_url: string } }
  | { readonly template: "sign_in_code"; readonly data: { code: string } }
  | {
      readonly template: "account_signer_invite";
      readonly data: {
        inviter_name: string;
        org_name: string;
        document_title: string;
        sign_url: string;
      };
    }
  | {
      readonly template: "account_task_reminder";
      readonly data: { org_name: string; task_title: string; task_url: string };
    }
  | {
      readonly template: "account_invite";
      readonly data: { org_name: string; sign_in_url: string };
    }
  | { readonly template: "plain"; readonly data: { text: string } };

/** The subject line of a catalog email in `locale`; null for "plain", whose caller writes it. */
export function subjectOf(t: EmailTemplate, locale?: string | null): string | null {
  const tr = translator(locale);
  switch (t.template) {
    case "workspace_invite":
      return tr("email.workspace_invite.subject", t.data);
    case "workspace_added":
      return tr("email.workspace_added.subject", t.data);
    case "org_invite":
      return tr("email.org_invite.subject", t.data);
    case "registration_existing_account":
      return tr("email.registration_existing_account.subject");
    case "verify_email":
      return tr("email.verify_email.subject");
    case "sign_in_code":
      return tr("email.sign_in_code.subject");
    case "account_signer_invite":
      return tr("email.account_signer_invite.subject", t.data);
    case "account_task_reminder":
      return tr("email.account_task_reminder.subject", t.data);
    case "account_invite":
      return tr("email.account_invite.subject", t.data);
    case "plain":
      return null;
  }
}

/** Escapes every value, for the parts of the HTML that show values as plain text. */
const escAll = (d: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, esc(v)]));

/**
 * Renders the body of an email in `locale` (any stored language value; English when
 * absent). The subject comes from subjectOf.
 */
export function render(t: EmailTemplate, locale?: string | null): { html: string; text: string } {
  const tr = translator(locale);
  const signoff = tr("email.common.signoff");
  const ignore = P(15, "0 0 28px", tr("email.common.ignore"));
  const ignoreText = tr("email.common.ignore_text");
  switch (t.template) {
    case "workspace_invite": {
      const d = t.data;
      const k = "email.workspace_invite";
      return {
        html: layout(tr, {
          title: tr(`${k}.title`),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(
            17,
            "0 0 28px",
            tr(`${k}.body`, { ...escAll(d), workspace_name: em(d.workspace_name) }),
          ),
          cta: cta(tr(`${k}.cta`), d.invite_url),
          fallback: fallback(tr, d.invite_url),
          disclaim: ignore,
        }),
        text: `${tr(`${k}.body`, d)}\n\n${tr(`${k}.text_cta`)}\n${d.invite_url}\n\n${ignoreText}\n\n${signoff}`,
      };
    }
    case "workspace_added": {
      const d = t.data;
      const k = "email.workspace_added";
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`, escAll(d)),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(
            17,
            "0 0 28px",
            tr(`${k}.body`, { ...escAll(d), workspace_name: em(d.workspace_name) }),
          ),
          cta: cta(tr(`${k}.cta`), d.invite_url),
        }),
        text: `${tr(`${k}.body`, d)}\n\n${tr(`${k}.text_cta`)}\n${d.invite_url}\n\n${signoff}`,
      };
    }
    case "org_invite": {
      const d = t.data;
      const k = "email.org_invite";
      const asRole = d.role && d.role !== "member";
      const bodyKey = asRole ? `${k}.body_role` : `${k}.body`;
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`, escAll(d)),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`, escAll(d)),
          body: `${P(17, "0 0 28px", tr(bodyKey, { ...escAll(d), org_name: em(d.org_name), role: em(d.role) }))}\n${P(15, "0 0 28px", tr(`${k}.next`))}`,
          cta: cta(tr(`${k}.cta`), d.invite_url),
          fallback: fallback(tr, d.invite_url),
          disclaim: ignore,
        }),
        text: `${tr(bodyKey, d)}\n\n${tr(`${k}.text_cta`)}\n${d.invite_url}\n\n${tr(`${k}.next`)}\n\n${ignoreText}\n\n${signoff}`,
      };
    }
    case "registration_existing_account": {
      const d = t.data;
      const k = "email.registration_existing_account";
      const link = `<a href="${esc(d.reset_url)}" style="color:#4169E1;">${tr(`${k}.reset_link`)}</a>`;
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`),
          heading: tr(`${k}.heading`),
          body: P(17, "0 0 28px", tr(`${k}.body`)),
          cta: cta(tr(`${k}.cta`), d.login_url),
          fallback: fallback(tr, d.login_url),
          disclaim: `${P(15, "0 0 8px", tr(`${k}.reset`, { reset_link: link }))}\n${P(15, "0 0 28px", tr(`${k}.ignore`))}`,
        }),
        text: `${tr(`${k}.heading`)}\n\n${tr(`${k}.body`)}\n\n${tr(`${k}.text_cta`)}\n${d.login_url}\n\n${tr(`${k}.reset_text`)}\n${d.reset_url}\n\n${tr(`${k}.ignore`)}\n\n${signoff}`,
      };
    }
    case "verify_email": {
      const d = t.data;
      const k = "email.verify_email";
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`),
          heading: tr(`${k}.heading`),
          body: P(17, "0 0 28px", tr(`${k}.body`)),
          cta: cta(tr(`${k}.cta`), d.verify_url),
          fallback: fallback(tr, d.verify_url),
          disclaim: P(15, "0 0 28px", tr(`${k}.ignore`)),
        }),
        text: `${tr(`${k}.heading`)}\n\n${tr(`${k}.text_cta`)}\n${d.verify_url}\n\n${tr(`${k}.ignore`)}\n\n${signoff}`,
      };
    }
    case "sign_in_code": {
      const d = t.data;
      const k = "email.sign_in_code";
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(17, "0 0 28px", tr(`${k}.body`, { code: em(d.code) })),
          disclaim: P(15, "0 0 28px", tr(`${k}.ignore`)),
        }),
        text: `${tr(`${k}.text_body`, d)}\n\n${tr(`${k}.ignore`)}\n\n${signoff}`,
      };
    }
    case "account_signer_invite": {
      // Someone named as the signer of one document: the link signs them in with a
      // one-time code and opens only that document.
      const d = t.data;
      const k = "email.account_signer_invite";
      return {
        html: layout(tr, {
          title: tr(`${k}.title`, escAll(d)),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(
            17,
            "0 0 28px",
            tr(`${k}.body`, {
              ...escAll(d),
              document_title: em(d.document_title),
              org_name: em(d.org_name),
            }),
          ),
          cta: cta(tr(`${k}.cta`), d.sign_url),
          fallback: fallback(tr, d.sign_url),
          disclaim: ignore,
        }),
        text: `${tr(`${k}.body`, d)}\n\n${tr(`${k}.text_cta`)}\n${d.sign_url}\n\n${ignoreText}\n\n${signoff}`,
      };
    }
    case "account_task_reminder": {
      // Sent every few days while a task waits on the customer; stops when it is done.
      const d = t.data;
      const k = "email.account_task_reminder";
      return {
        html: layout(tr, {
          title: tr(`${k}.title`, escAll(d)),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(17, "0 0 28px", tr(`${k}.body`, { ...escAll(d), task_title: em(d.task_title) })),
          cta: cta(tr(`${k}.cta`), d.task_url),
          fallback: fallback(tr, d.task_url),
        }),
        text: `${tr(`${k}.body`, d)}\n\n${tr(`${k}.text_cta`)}\n${d.task_url}\n\n${signoff}`,
      };
    }
    case "account_invite": {
      // The contact of a demo made in echo, invited when staff publish it.
      const d = t.data;
      const k = "email.account_invite";
      return {
        html: layout(tr, {
          title: tr(`${k}.subject`, escAll(d)),
          preview: tr(`${k}.preview`, escAll(d)),
          heading: tr(`${k}.heading`),
          body: P(17, "0 0 28px", tr(`${k}.body`, { org_name: em(d.org_name) })),
          cta: cta(tr(`${k}.cta`), d.sign_in_url),
          fallback: fallback(tr, d.sign_in_url),
          disclaim: ignore,
        }),
        text: `${tr(`${k}.body`, d)}\n\n${tr(`${k}.text_cta`)}\n${d.sign_in_url}\n\n${ignoreText}\n\n${signoff}`,
      };
    }
    case "plain":
      return {
        html: `<pre style="font-family:inherit; white-space:pre-wrap;">${esc(t.data.text)}</pre>`,
        text: t.data.text,
      };
  }
}
