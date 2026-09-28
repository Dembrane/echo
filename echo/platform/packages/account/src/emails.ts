/**
 * Transactional emails of the account area, ported from the Jinja templates in
 * echo/server/email_templates with the same copy and layout. HTML values are escaped the
 * way Jinja's autoescape did; the text part is sent alongside every HTML part.
 */

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

function fallback(url: string): string {
  return `<p style="font-size:13px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight: 400;">
  Or paste this into your browser:<br>
  <span style="color:#4169E1; word-break:break-all;">${esc(url)}</span>
</p>`;
}

/** The shared frame: letter-style card, logo, heading, body, sign-off and banner. */
function layout(b: {
  title: string;
  preview: string;
  heading: string;
  body: string;
  cta?: string;
  fallback?: string;
  disclaim?: string;
}): string {
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
                The dembrane team
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

const IGNORE = "Didn't expect this? You can ignore this email. Nothing will happen.";

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

/** Renders the body of an email; the subject is chosen by the caller, as it was before. */
export function render(t: EmailTemplate): { html: string; text: string } {
  switch (t.template) {
    case "workspace_invite": {
      const d = t.data;
      return {
        html: layout({
          title: "You're invited to collaborate on dembrane",
          preview: `${esc(d.inviter_name)} invited you to join ${esc(d.workspace_name)} on dembrane.`,
          heading: "You've been invited to collaborate.",
          body: P(
            17,
            "0 0 28px",
            `${esc(d.inviter_name)} invited you to join ${em(d.workspace_name)} on dembrane. The invite expires in 7 days.`,
          ),
          cta: cta("Accept invitation", d.invite_url),
          fallback: fallback(d.invite_url),
          disclaim: P(15, "0 0 28px", IGNORE),
        }),
        text: `${d.inviter_name} invited you to join ${d.workspace_name} on dembrane. The invite expires in 7 days.\n\nAccept the invitation:\n${d.invite_url}\n\nDidn't expect this? Ignore this email. Nothing will happen.\n\nThe dembrane team`,
      };
    }
    case "workspace_added": {
      const d = t.data;
      return {
        html: layout({
          title: `You've been added to ${esc(d.workspace_name)}`,
          preview: `${esc(d.inviter_name)} added you to ${esc(d.workspace_name)} on dembrane.`,
          heading: "You're in.",
          body: P(
            17,
            "0 0 28px",
            `${esc(d.inviter_name)} added you to ${em(d.workspace_name)} on dembrane. You can start collaborating right away.`,
          ),
          cta: cta("Open workspace", d.invite_url),
        }),
        text: `${d.inviter_name} added you to ${d.workspace_name} on dembrane. You can start collaborating right away.\n\nOpen the workspace:\n${d.invite_url}\n\nThe dembrane team`,
      };
    }
    case "org_invite": {
      const d = t.data;
      const asRole = d.role && d.role !== "member";
      return {
        html: layout({
          title: `${esc(d.inviter_name)} invited you to ${esc(d.org_name)} on dembrane`,
          preview: `${esc(d.inviter_name)} invited you to join ${esc(d.org_name)} on dembrane.`,
          heading: `You've been invited to ${esc(d.org_name)}.`,
          body: `${P(17, "0 0 28px", `${esc(d.inviter_name)} invited you to join ${em(d.org_name)} on dembrane${asRole ? ` as ${em(d.role)}` : ""}. The invite expires in 7 days.`)}\n${P(15, "0 0 28px", "Once you accept, you can discover and request access to the workspaces your team is using.")}`,
          cta: cta("Accept invitation", d.invite_url),
          fallback: fallback(d.invite_url),
          disclaim: P(15, "0 0 28px", IGNORE),
        }),
        text: `${d.inviter_name} invited you to join ${d.org_name} on dembrane${asRole ? ` as ${d.role}` : ""}. The invite expires in 7 days.\n\nAccept the invitation:\n${d.invite_url}\n\nOnce you accept, you can discover and request access to the workspaces your team is using.\n\nDidn't expect this? Ignore this email. Nothing will happen.\n\nThe dembrane team`,
      };
    }
    case "registration_existing_account": {
      const d = t.data;
      return {
        html: layout({
          title: "You already have a dembrane account",
          preview: "You already have a dembrane account. Sign in to continue.",
          heading: "You already have an account.",
          body: P(
            17,
            "0 0 28px",
            "It looks like an account with this email already exists. You can sign in using your existing credentials.",
          ),
          cta: cta("Sign in", d.login_url),
          fallback: fallback(d.login_url),
          disclaim: `${P(15, "0 0 8px", `If you forgot your password, you can <a href="${esc(d.reset_url)}" style="color:#4169E1;">reset it here</a>.`)}\n${P(15, "0 0 28px", "If you didn't try to sign up, you can safely ignore this email. No changes have been made to your account.")}`,
        }),
        text: `You already have an account.\n\nIt looks like an account with this email already exists. You can sign in using your existing credentials.\n\nSign in:\n${d.login_url}\n\nIf you forgot your password, you can reset it here:\n${d.reset_url}\n\nIf you didn't try to sign up, you can safely ignore this email. No changes have been made to your account.\n\nThe dembrane team`,
      };
    }
    case "verify_email": {
      const d = t.data;
      return {
        html: layout({
          title: "Verify your email",
          preview: "Confirm your email to finish setting up your dembrane account.",
          heading: "Verify your email.",
          body: P(
            17,
            "0 0 28px",
            "Confirm this is your email address to finish setting up your dembrane account.",
          ),
          cta: cta("Verify email", d.verify_url),
          fallback: fallback(d.verify_url),
          disclaim: P(15, "0 0 28px", "If you didn't sign up, you can safely ignore this email."),
        }),
        text: `Verify your email.\n\nConfirm this is your email address to finish setting up your dembrane account:\n${d.verify_url}\n\nIf you didn't sign up, you can safely ignore this email.\n\nThe dembrane team`,
      };
    }
    case "sign_in_code": {
      const d = t.data;
      return {
        html: layout({
          title: "Your dembrane sign-in code",
          preview: `Your sign-in code is ${esc(d.code)}.`,
          heading: "Your sign-in code.",
          body: P(
            17,
            "0 0 28px",
            `Enter this code to continue: ${em(d.code)}. It expires in 10 minutes.`,
          ),
          disclaim: P(
            15,
            "0 0 28px",
            "If you didn't try to sign in, you can safely ignore this email.",
          ),
        }),
        text: `Your sign-in code is ${d.code}. It expires in 10 minutes.\n\nIf you didn't try to sign in, you can safely ignore this email.\n\nThe dembrane team`,
      };
    }
    case "account_signer_invite": {
      // Someone named as the signer of one document: the link signs them in with a
      // one-time code and opens only that document.
      const d = t.data;
      return {
        html: layout({
          title: `${esc(d.inviter_name)} asked you to sign for ${esc(d.org_name)}`,
          preview: `${esc(d.inviter_name)} asked you to sign ${esc(d.document_title)} on dembrane.`,
          heading: "You've been asked to sign.",
          body: P(
            17,
            "0 0 28px",
            `${esc(d.inviter_name)} named you as the person who signs ${em(d.document_title)} for ${em(d.org_name)}. Sign in with a code sent to this address to read and sign it.`,
          ),
          cta: cta("Read and sign", d.sign_url),
          fallback: fallback(d.sign_url),
          disclaim: P(15, "0 0 28px", IGNORE),
        }),
        text: `${d.inviter_name} named you as the person who signs ${d.document_title} for ${d.org_name}. Sign in with a code sent to this address to read and sign it.\n\nRead and sign:\n${d.sign_url}\n\nDidn't expect this? Ignore this email. Nothing will happen.\n\nThe dembrane team`,
      };
    }
    case "account_task_reminder": {
      // Sent every few days while a task waits on the customer; stops when it is done.
      const d = t.data;
      return {
        html: layout({
          title: `A step is waiting for ${esc(d.org_name)}`,
          preview: `${esc(d.task_title)} is still open on dembrane.`,
          heading: "One step is still open.",
          body: P(
            17,
            "0 0 28px",
            `${em(d.task_title)} is still waiting for ${esc(d.org_name)} on dembrane. It takes a minute, and it keeps things moving on our side.`,
          ),
          cta: cta("Open the step", d.task_url),
          fallback: fallback(d.task_url),
        }),
        text: `${d.task_title} is still waiting for ${d.org_name} on dembrane. It takes a minute, and it keeps things moving on our side.\n\nOpen the step:\n${d.task_url}\n\nThe dembrane team`,
      };
    }
    case "account_invite": {
      // The contact of a demo made in echo, invited when staff publish it.
      const d = t.data;
      return {
        html: layout({
          title: `Your dembrane account for ${esc(d.org_name)}`,
          preview: `Your dembrane account for ${esc(d.org_name)} is ready.`,
          heading: "Your account is ready.",
          body: P(
            17,
            "0 0 28px",
            `We set up ${em(d.org_name)} on dembrane for you. Sign in with a code we send to this address: no password needed.`,
          ),
          cta: cta("Sign in", d.sign_in_url),
          fallback: fallback(d.sign_in_url),
          disclaim: P(15, "0 0 28px", IGNORE),
        }),
        text: `We set up ${d.org_name} on dembrane for you. Sign in with a code we send to this address: no password needed.\n\nSign in:\n${d.sign_in_url}\n\nDidn't expect this? Ignore this email. Nothing will happen.\n\nThe dembrane team`,
      };
    }
    case "plain":
      return {
        html: `<pre style="font-family:inherit; white-space:pre-wrap;">${esc(t.data.text)}</pre>`,
        text: t.data.text,
      };
  }
}
