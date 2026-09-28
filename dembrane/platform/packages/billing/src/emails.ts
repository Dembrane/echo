import { type MessageParams, translator } from "@dembrane/i18n";
import { escapeHtml } from "@dembrane/mail";

/**
 * The transactional email frame (the old _layout.html): a letter-style card, heading,
 * body, one pill button, sign-off and the crowd banner. Values are escaped here, the
 * way Jinja autoescaped them; `body` is trusted HTML built by the templates below. Every
 * sentence comes from the server catalog (@dembrane/i18n) in the recipient's language;
 * English renders as the old templates did.
 */
export interface EmailParts {
  readonly title: string;
  readonly preview: string;
  readonly heading: string;
  readonly bodyHtml: string;
  readonly cta?: { readonly label: string; readonly url: string };
  /** The sign-off line, in the email's language. */
  readonly signoff?: string;
}

const P17 =
  'style="font-size:17px; line-height:1.65; margin:0 0 20px; color:#2D2D2C; font-weight:400;"';
const P15 =
  'style="font-size:15px; line-height:1.65; margin:0 0 24px; color:#2D2D2C; font-weight:400;"';
const EM = 'style="color:#4169E1; font-style:normal;"';
export const emailStyles = { P17, P15, EM };

export function emailLayout(p: EmailParts): string {
  const cta = p.cta
    ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;"><tr><td><a href="${escapeHtml(p.cta.url)}" style="display:inline-block; background-color:#4169E1; color:#FFFFFF; text-decoration:none; padding:14px 30px; border-radius:9999px; font-size:15px; font-weight:400; font-family:inherit; line-height:1;">${escapeHtml(p.cta.label)}</a></td></tr></table>`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(p.title)}</title>
  <style>@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&display=swap');</style>
</head>
<body style="margin:0; padding:0; background-color:#F6F4F1; font-family:'DM Sans','DM Sans Variable',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; color:#2D2D2C; font-weight: 400;">
  <div style="display:none; font-size:1px; color:#F6F4F1; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">${escapeHtml(p.preview)}</div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#F6F4F1; padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px; background-color:#FFFFFF; border:1px solid #EFEAE2;">
        <tr><td style="padding:32px 48px 0;"><img src="https://dashboard.echo-next.dembrane.com/dembrane-logo-email.png" alt="dembrane" width="147" height="30" border="0" style="height:30px; width:auto; max-width:100%; display:block; border:0; outline:none; text-decoration:none;"></td></tr>
        <tr><td style="padding:28px 48px 0;">
          <h1 style="margin:0 0 20px; font-family:inherit; font-size:32px; font-weight: 400; letter-spacing:-0.01em; line-height:1.15; color:#2D2D2C;">${escapeHtml(p.heading)}</h1>
          <div style="font-size:17px; line-height:1.65; color:#2D2D2C; font-weight: 400;">${p.bodyHtml}</div>
          ${cta}
          <p style="font-size:17px; line-height:1.65; margin:0 0 32px; color:#2D2D2C; font-weight: 400;">${escapeHtml(p.signoff ?? "The dembrane team")}</p>
        </td></tr>
        <tr><td style="background-color:#FFFFFF;"><img src="https://directus.dembrane.com/assets/a75db1e0-4dd9-4660-a6fb-24e0dd4cd104" alt="" width="600" border="0" style="width:100%; max-width:600px; height:auto; display:block; border:0;"></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const list = (items: readonly string[]) =>
  `<ul style="margin:0 0 20px; padding-left:20px; color:#2D2D2C; font-size:15px; line-height:1.7; font-weight:400;">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;

const em = (v: string) => `<em ${EM}>${escapeHtml(v)}</em>`;
const escAll = (d: MessageParams) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, escapeHtml(String(v))]));

export function paymentFailedEmail(billingUrl: string, locale?: string | null): RenderedEmail {
  const tr = translator(locale);
  const k = "email.payment_failed";
  const signoff = tr("email.common.signoff");
  return {
    subject: tr(`${k}.subject`),
    html: emailLayout({
      title: tr(`${k}.title`),
      preview: tr(`${k}.preview`),
      heading: tr(`${k}.heading`),
      bodyHtml: `<p ${P17}>${tr(`${k}.body`)}</p><p ${P15}>${tr(`${k}.next`)}</p>`,
      cta: { label: tr(`${k}.cta`), url: billingUrl },
      signoff,
    }),
    text: `${tr(`${k}.heading`)}

${tr(`${k}.body`)}

${tr(`${k}.next`)}

${tr(`${k}.text_cta`)}
${billingUrl}

${signoff}
`,
  };
}

export function tierExpiredEmail(
  p: {
    workspaceName: string;
    fromTier: string;
    freezeItems: readonly string[];
    revertItems: readonly string[];
    workspaceUrl: string;
  },
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const k = "email.tier_expired";
  const d = "email.tier_downgraded";
  const signoff = tr("email.common.signoff");
  const v = { workspace_name: p.workspaceName, from_tier: p.fromTier };
  let body = `<p ${P17}>${tr(`${k}.body`, { from_tier: em(p.fromTier), workspace_name: em(p.workspaceName) })}</p>`;
  if (p.freezeItems.length) body += `<p ${P15}>${tr(`${d}.frozen`)}</p>${list(p.freezeItems)}`;
  if (p.revertItems.length) body += `<p ${P15}>${tr(`${d}.reverted`)}</p>${list(p.revertItems)}`;
  body += `<p ${P15}>${tr(`${k}.rest`)}</p>`;
  let text = `${tr(`${k}.text_body`, v)}\n\n`;
  if (p.freezeItems.length)
    text += `${tr(`${d}.frozen_text`)}\n${p.freezeItems.map((i) => `- ${i}\n`).join("")}\n`;
  if (p.revertItems.length)
    text += `${tr(`${d}.reverted_text`)}\n${p.revertItems.map((i) => `- ${i}\n`).join("")}\n`;
  text += `${tr(`${k}.rest`)}\n\n${tr(`${d}.text_cta`)}\n${p.workspaceUrl}\n\n${signoff}\n`;
  return {
    subject: tr(`${k}.subject`, v),
    html: emailLayout({
      title: tr(`${k}.title`, v),
      preview: tr(`${k}.preview`, v),
      heading: tr(`${k}.heading`, v),
      bodyHtml: body,
      cta: { label: tr(`${k}.cta`), url: p.workspaceUrl },
      signoff,
    }),
    text,
  };
}

export function tierExpiringSoonEmail(
  p: {
    workspaceName: string;
    currentTier: string;
    expiresDate: string;
    workspaceUrl: string;
  },
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const k = "email.tier_expiring";
  const signoff = tr("email.common.signoff");
  const v = { workspace_name: p.workspaceName, tier: p.currentTier, date: p.expiresDate };
  const bodyV = {
    ...escAll(v),
    tier: em(p.currentTier),
    workspace_name: em(p.workspaceName),
    date: em(p.expiresDate),
  };
  return {
    subject: tr(`${k}.subject`, v),
    html: emailLayout({
      title: tr(`${k}.title`, v),
      preview: tr(`${k}.preview`, v),
      heading: tr(`${k}.heading`, v),
      bodyHtml: `<p ${P17}>${tr(`${k}.body`, bodyV)}</p><p ${P15}>${tr(`${k}.rest`)}</p>`,
      cta: { label: tr(`${k}.cta`), url: p.workspaceUrl },
      signoff,
    }),
    text: `${tr(`${k}.text_body`, v)}

${tr(`${k}.rest`)}

${tr("email.tier_downgraded.text_cta")}
${p.workspaceUrl}

${signoff}
`,
  };
}
