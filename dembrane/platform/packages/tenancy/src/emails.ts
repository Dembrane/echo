import { type MessageParams, type Translate, translator } from "@dembrane/i18n";

/**
 * The transactional emails this namespace sends, in the recipient's language: every
 * sentence comes from the server catalog (@dembrane/i18n). English renders to the same
 * subject, HTML and text as the old API's Jinja templates (server/email_templates). HTML
 * values are escaped; the text part is not, matching Jinja's autoescape rules.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

const P = (size: number, margin: string, inner: string) =>
  `<p style="font-size:${size}px; line-height:1.65; margin:${margin}; color:#2D2D2C; font-weight:400;">\n  ${inner}\n</p>`;
const EM = (v: string) => `<em style="color:#4169E1; font-style:normal;">${esc(v)}</em>`;

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

const disclaim = (tr: Translate) => P(15, "0 0 28px", tr("email.common.ignore"));

/** Escapes every value, for the parts of the HTML that show values as plain text. */
const escAll = (d: MessageParams) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, esc(v)]));

/** The shared letter-style frame (email_templates/_layout.html). */
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

/** org_invite: someone without an account is invited to an org. */
export function orgInviteEmail(
  d: { inviterName: string; orgName: string; role: string; inviteUrl: string },
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const k = "email.org_invite";
  const p = { inviter_name: d.inviterName, org_name: d.orgName, role: d.role };
  const bodyKey = d.role && d.role !== "member" ? `${k}.body_role` : `${k}.body`;
  return {
    subject: tr(`${k}.subject`, p),
    html: layout(tr, {
      title: tr(`${k}.subject`, escAll(p)),
      preview: tr(`${k}.preview`, escAll(p)),
      heading: tr(`${k}.heading`, escAll(p)),
      body: `${P(17, "0 0 28px", tr(bodyKey, { ...escAll(p), org_name: EM(d.orgName), role: EM(d.role) }))}\n${P(15, "0 0 28px", tr(`${k}.next`))}`,
      cta: cta(tr(`${k}.cta`), d.inviteUrl),
      fallback: fallback(tr, d.inviteUrl),
      disclaim: disclaim(tr),
    }),
    text: `${tr(bodyKey, p)}\n\n${tr(`${k}.text_cta`)}\n${d.inviteUrl}\n\n${tr(`${k}.next`)}\n\n${tr("email.common.ignore_text")}\n\n${tr("email.common.signoff")}`,
  };
}

/** workspace_invite, used for the data owner of an external-client workspace. */
export function workspaceInviteEmail(
  d: { subject?: string; inviterName: string; workspaceName: string; inviteUrl: string },
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const k = "email.workspace_invite";
  const p = { inviter_name: d.inviterName, workspace_name: d.workspaceName };
  return {
    subject: d.subject ?? tr("email.data_owner_invite.subject", p),
    html: layout(tr, {
      title: tr(`${k}.title`),
      preview: tr(`${k}.preview`, escAll(p)),
      heading: tr(`${k}.heading`),
      body: P(
        17,
        "0 0 28px",
        tr(`${k}.body`, { ...escAll(p), workspace_name: EM(d.workspaceName) }),
      ),
      cta: cta(tr(`${k}.cta`), d.inviteUrl),
      fallback: fallback(tr, d.inviteUrl),
      disclaim: disclaim(tr),
    }),
    text: `${tr(`${k}.body`, p)}\n\n${tr(`${k}.text_cta`)}\n${d.inviteUrl}\n\n${tr("email.common.ignore_text")}\n\n${tr("email.common.signoff")}`,
  };
}

/** tier_downgraded: sent to admins and billing after a staff downgrade. */
export function tierDowngradedEmail(
  d: {
    workspaceName: string;
    fromTier: string;
    toTier: string;
    downgradedAtHuman: string;
    freezeItems: readonly string[];
    revertItems: readonly string[];
    workspaceUrl: string;
  },
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const k = "email.tier_downgraded";
  const p = {
    workspace_name: d.workspaceName,
    from_tier: d.fromTier,
    to_tier: d.toTier,
    date: d.downgradedAtHuman,
  };
  const list = (items: readonly string[]) =>
    `<ul style="margin:0 0 20px; padding-left:20px; color:#2D2D2C; font-size:15px; line-height:1.7; font-weight:400;">\n  ${items.map((i) => `<li>${esc(i)}</li>`).join("")}\n</ul>`;
  const body = [
    `<p style="font-size:17px; line-height:1.65; margin:0 0 20px; color:#2D2D2C; font-weight:400;">\n  ${tr(`${k}.body`, { ...escAll(p), workspace_name: EM(d.workspaceName) })}\n</p>`,
    d.freezeItems.length
      ? `<p style="font-size:15px; line-height:1.65; margin:0 0 8px; color:#2D2D2C; font-weight:400;">\n  ${tr(`${k}.frozen`)}\n</p>\n${list(d.freezeItems)}`
      : "",
    d.revertItems.length
      ? `<p style="font-size:15px; line-height:1.65; margin:0 0 8px; color:#2D2D2C; font-weight:400;">\n  ${tr(`${k}.reverted`)}\n</p>\n${list(d.revertItems)}`
      : "",
    P(15, "0 0 24px", tr(`${k}.rest`)),
  ]
    .filter(Boolean)
    .join("\n\n");
  const textList = (items: readonly string[]) => items.map((i) => `- ${i}\n`).join("");
  return {
    subject: tr(`${k}.subject`, p).replace(/[\r\n]/g, " "),
    html: layout(tr, {
      title: tr(`${k}.subject`, escAll(p)),
      preview: tr(`${k}.preview`, escAll(p)),
      heading: tr(`${k}.heading`, escAll(p)),
      body,
      cta: cta(tr(`${k}.cta`), d.workspaceUrl),
    }),
    text: `${tr(`${k}.text_body`, p)}

${d.freezeItems.length ? `${tr(`${k}.frozen_text`)}\n${textList(d.freezeItems)}\n` : ""}
${d.revertItems.length ? `${tr(`${k}.reverted_text`)}\n${textList(d.revertItems)}\n` : ""}
${tr(`${k}.rest_text`)}

${tr(`${k}.text_cta`)}
${d.workspaceUrl}

${tr("email.common.signoff")}`,
  };
}

type SupportTemplate =
  | { kind: "request"; staffName: string; note: string; settingsUrl: string }
  | { kind: "joined"; staffName: string; settingsUrl: string }
  | { kind: "ended"; settingsUrl: string }
  | { kind: "reminder"; settingsUrl: string }
  | { kind: "resolved"; decision: "approved" | "denied"; workspaceUrl: string };

/** The support access emails; these templates have no text part in the old API either. */
export function supportAccessEmail(
  workspaceName: string,
  t: SupportTemplate,
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const ws = EM(workspaceName);
  const staff = "staffName" in t ? t.staffName : "";
  const plain = { workspace_name: workspaceName, staff_name: staff };
  const html = escAll(plain);
  const inBody = { ...html, workspace_name: ws };
  const k =
    t.kind === "request"
      ? "email.support_request"
      : t.kind === "joined"
        ? "email.support_joined"
        : t.kind === "ended"
          ? "email.support_ended"
          : t.kind === "reminder"
            ? "email.support_reminder"
            : `email.support_${t.decision}`;
  const head = {
    title: tr(`${k}.subject`, html),
    preview: tr(`${k}.preview`, html),
    heading: tr(`${k}.heading`),
  };
  const subject = tr(`${k}.subject`, plain);
  switch (t.kind) {
    case "request":
      return {
        subject,
        text: "",
        html: layout(tr, {
          ...head,
          body: P(
            17,
            "0 0 28px",
            `${tr(`${k}.body`, inBody)}\n  ${t.note ? tr(`${k}.note`, { note: esc(t.note) }) : ""}\n  ${tr(`${k}.end`)}`,
          ),
          cta: cta(tr(`${k}.cta`), t.settingsUrl),
        }),
      };
    case "joined":
    case "ended":
    case "reminder":
      return {
        subject,
        text: "",
        html: layout(tr, {
          ...head,
          body: P(17, "0 0 28px", `${tr(`${k}.body`, inBody)}\n  ${tr(`${k}.end`)}`),
          cta: cta(tr(`${k}.cta`), t.settingsUrl),
        }),
      };
    case "resolved":
      return {
        subject,
        text: "",
        html: layout(tr, {
          ...head,
          body: P(
            17,
            "0 0 28px",
            `${tr(`${k}.body`, inBody)}\n  ${t.decision === "approved" ? tr(`${k}.end`) : ""}`,
          ),
          ...(t.decision === "approved" && { cta: cta(tr(`${k}.cta`), t.workspaceUrl) }),
        }),
      };
  }
}
