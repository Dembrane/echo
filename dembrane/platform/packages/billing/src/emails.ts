import { escapeHtml } from "@dembrane/mail";

/**
 * The transactional email frame (the old _layout.html): a letter-style card, heading,
 * body, one pill button, sign-off and the crowd banner. Values are escaped here, the
 * way Jinja autoescaped them; `body` is trusted HTML built by the templates below.
 */
export interface EmailParts {
  readonly title: string;
  readonly preview: string;
  readonly heading: string;
  readonly bodyHtml: string;
  readonly cta?: { readonly label: string; readonly url: string };
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
          <p style="font-size:17px; line-height:1.65; margin:0 0 32px; color:#2D2D2C; font-weight: 400;">The dembrane team</p>
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

export function paymentFailedEmail(billingUrl: string): RenderedEmail {
  return {
    subject: "Action needed: update your payment method",
    html: emailLayout({
      title: "Update your payment method",
      preview: "A recent payment didn't go through. Update your method to keep your plan.",
      heading: "We couldn't charge your payment method.",
      bodyHtml: `<p ${P17}>A recent payment for your dembrane plan didn't go through. This usually means a card expired or a bank declined the charge.</p><p ${P15}>Your plan stays fully active while you sort this out. Update your payment method to settle the balance and keep things running.</p>`,
      cta: { label: "Update payment method", url: billingUrl },
    }),
    text: `We couldn't charge your payment method.

A recent payment for your dembrane plan didn't go through. This usually means a card expired or a bank declined the charge.

Your plan stays fully active while you sort this out. Update your payment method to settle the balance and keep things running.

Update your payment method:
${billingUrl}

The dembrane team
`,
  };
}

export function tierExpiredEmail(p: {
  workspaceName: string;
  fromTier: string;
  freezeItems: readonly string[];
  revertItems: readonly string[];
  workspaceUrl: string;
}): RenderedEmail {
  const ws = escapeHtml(p.workspaceName);
  let body = `<p ${P17}>Your <em ${EM}>${escapeHtml(p.fromTier)}</em> tier on <em ${EM}>${ws}</em> has expired. The workspace is now on the free tier.</p>`;
  if (p.freezeItems.length)
    body += `<p ${P15}>These features are frozen. Existing state stays, with no new use until upgrade:</p>${list(p.freezeItems)}`;
  if (p.revertItems.length)
    body += `<p ${P15}>These features were reverted:</p>${list(p.revertItems)}`;
  body += `<p ${P15}>Your existing content stays accessible. Request an upgrade to restore full features.</p>`;
  let text = `${p.workspaceName}: your ${p.fromTier} tier has expired. The workspace is now on free.\n\n`;
  if (p.freezeItems.length)
    text += `Frozen. Existing state stays, with no new use until upgrade:\n${p.freezeItems.map((i) => `- ${i}\n`).join("")}\n`;
  if (p.revertItems.length) text += `Reverted:\n${p.revertItems.map((i) => `- ${i}\n`).join("")}\n`;
  text += `Your existing content stays accessible. Request an upgrade to restore full features.\n\nOpen the workspace:\n${p.workspaceUrl}\n\nThe dembrane team\n`;
  return {
    subject: `${p.workspaceName} moved to free`,
    html: emailLayout({
      title: `${p.workspaceName} tier expired`,
      preview: `${p.workspaceName} moved to free. Some features are limited.`,
      heading: `${p.workspaceName} is now on free.`,
      bodyHtml: body,
      cta: { label: "Open workspace", url: p.workspaceUrl },
    }),
    text,
  };
}

export function tierExpiringSoonEmail(p: {
  workspaceName: string;
  currentTier: string;
  expiresDate: string;
  workspaceUrl: string;
}): RenderedEmail {
  return {
    subject: `${p.workspaceName} tier expires ${p.expiresDate}`,
    html: emailLayout({
      title: `${p.workspaceName} tier expiring soon`,
      preview: `${p.workspaceName} moves to free on ${p.expiresDate}.`,
      heading: `${p.workspaceName} tier expires ${p.expiresDate}.`,
      bodyHtml: `<p ${P17}>Your <em ${EM}>${escapeHtml(p.currentTier)}</em> tier on <em ${EM}>${escapeHtml(p.workspaceName)}</em> expires on <em ${EM}>${escapeHtml(p.expiresDate)}</em>. After that, the workspace moves to free and some features will be limited.</p><p ${P15}>Your existing content stays accessible. Request an upgrade to keep full features.</p>`,
      cta: { label: "Request upgrade", url: p.workspaceUrl },
    }),
    text: `${p.workspaceName}: your ${p.currentTier} tier expires on ${p.expiresDate}. After that, the workspace moves to free and some features will be limited.

Your existing content stays accessible. Request an upgrade to keep full features.

Open the workspace:
${p.workspaceUrl}

The dembrane team
`,
  };
}
