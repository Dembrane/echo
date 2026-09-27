/**
 * The transactional emails this namespace sends, rendered to the same subject, HTML and text
 * as the old API's Jinja templates (server/email_templates). HTML values are escaped; the
 * text part is not, matching Jinja's autoescape rules for .html and .txt.
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

function fallback(url: string): string {
  return `<p style="font-size:13px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight: 400;">
  Or paste this into your browser:<br>
  <span style="color:#4169E1; word-break:break-all;">${esc(url)}</span>
</p>`;
}

const DISCLAIM = P(
  15,
  "0 0 28px",
  "Didn't expect this? You can ignore this email. Nothing will happen.",
);

/** The shared letter-style frame (email_templates/_layout.html). */
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

const asRole = (role: string, html: boolean) =>
  role && role !== "member" ? ` as ${html ? EM(role) : role}` : "";

/** org_invite: someone without an account is invited to an org. */
export function orgInviteEmail(d: {
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
}): RenderedEmail {
  return {
    subject: `${d.inviterName} invited you to ${d.orgName} on dembrane`,
    html: layout({
      title: `${esc(d.inviterName)} invited you to ${esc(d.orgName)} on dembrane`,
      preview: `${esc(d.inviterName)} invited you to join ${esc(d.orgName)} on dembrane.`,
      heading: `You've been invited to ${esc(d.orgName)}.`,
      body: `${P(17, "0 0 28px", `${esc(d.inviterName)} invited you to join ${EM(d.orgName)} on dembrane${asRole(d.role, true)}. The invite expires in 7 days.`)}\n${P(15, "0 0 28px", "Once you accept, you can discover and request access to the workspaces your team is using.")}`,
      cta: cta("Accept invitation", d.inviteUrl),
      fallback: fallback(d.inviteUrl),
      disclaim: DISCLAIM,
    }),
    text: `${d.inviterName} invited you to join ${d.orgName} on dembrane${asRole(d.role, false)}. The invite expires in 7 days.

Accept the invitation:
${d.inviteUrl}

Once you accept, you can discover and request access to the workspaces your team is using.

Didn't expect this? Ignore this email. Nothing will happen.

The dembrane team`,
  };
}

/** org_added: an existing user was added (or re-added) to an org. */
export function orgAddedEmail(d: {
  subject: string;
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
}): RenderedEmail {
  return {
    subject: d.subject,
    html: layout({
      title: `You've been added to ${esc(d.orgName)}`,
      preview: `${esc(d.inviterName)} added you to ${esc(d.orgName)} on dembrane.`,
      heading: "You're in.",
      body: `${P(17, "0 0 28px", `${esc(d.inviterName)} added you to ${EM(d.orgName)} on dembrane${asRole(d.role, true)}.`)}\n${P(15, "0 0 28px", "You can discover and request access to the workspaces your team is using.")}`,
      cta: cta("Open dembrane", d.inviteUrl),
    }),
    text: `${d.inviterName} added you to ${d.orgName} on dembrane${asRole(d.role, false)}.

You can discover and request access to the workspaces your team is using.

Open dembrane:
${d.inviteUrl}

The dembrane team`,
  };
}

/** workspace_invite, used for the data owner of an external-client workspace. */
export function workspaceInviteEmail(d: {
  subject: string;
  inviterName: string;
  workspaceName: string;
  inviteUrl: string;
}): RenderedEmail {
  return {
    subject: d.subject,
    html: layout({
      title: "You're invited to collaborate on dembrane",
      preview: `${esc(d.inviterName)} invited you to join ${esc(d.workspaceName)} on dembrane.`,
      heading: "You've been invited to collaborate.",
      body: P(
        17,
        "0 0 28px",
        `${esc(d.inviterName)} invited you to join ${EM(d.workspaceName)} on dembrane. The invite expires in 7 days.`,
      ),
      cta: cta("Accept invitation", d.inviteUrl),
      fallback: fallback(d.inviteUrl),
      disclaim: DISCLAIM,
    }),
    text: `${d.inviterName} invited you to join ${d.workspaceName} on dembrane. The invite expires in 7 days.

Accept the invitation:
${d.inviteUrl}

Didn't expect this? Ignore this email. Nothing will happen.

The dembrane team`,
  };
}

/** tier_downgraded: sent to admins and billing after a staff downgrade. */
export function tierDowngradedEmail(d: {
  workspaceName: string;
  fromTier: string;
  toTier: string;
  downgradedAtHuman: string;
  freezeItems: readonly string[];
  revertItems: readonly string[];
  workspaceUrl: string;
}): RenderedEmail {
  const list = (items: readonly string[]) =>
    `<ul style="margin:0 0 20px; padding-left:20px; color:#2D2D2C; font-size:15px; line-height:1.7; font-weight:400;">\n  ${items.map((i) => `<li>${esc(i)}</li>`).join("")}\n</ul>`;
  const body = [
    `<p style="font-size:17px; line-height:1.65; margin:0 0 20px; color:#2D2D2C; font-weight:400;">\n  As of ${esc(d.downgradedAtHuman)}, ${EM(d.workspaceName)} moved from ${esc(d.fromTier)} to ${esc(d.toTier)}.\n</p>`,
    d.freezeItems.length
      ? `<p style="font-size:15px; line-height:1.65; margin:0 0 8px; color:#2D2D2C; font-weight:400;">\n  These features are frozen. Existing state stays, with no new use until upgrade:\n</p>\n${list(d.freezeItems)}`
      : "",
    d.revertItems.length
      ? `<p style="font-size:15px; line-height:1.65; margin:0 0 8px; color:#2D2D2C; font-weight:400;">\n  These features were reverted:\n</p>\n${list(d.revertItems)}`
      : "",
    P(
      15,
      "0 0 24px",
      "Everything else keeps working as it did. Open the workspace to review your options or request a different tier.",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  const textList = (items: readonly string[]) => items.map((i) => `- ${i}\n`).join("");
  return {
    subject: `${d.workspaceName} moved to ${d.toTier}`.replace(/[\r\n]/g, " "),
    html: layout({
      title: `${esc(d.workspaceName)} moved to ${esc(d.toTier)}`,
      preview: `${esc(d.workspaceName)} is now on ${esc(d.toTier)}. Some features are limited.`,
      heading: `${esc(d.workspaceName)} is on ${esc(d.toTier)}.`,
      body,
      cta: cta("Open workspace", d.workspaceUrl),
    }),
    text: `${d.workspaceName} moved from ${d.fromTier} to ${d.toTier} on ${d.downgradedAtHuman}.

${d.freezeItems.length ? `Frozen. Existing state stays, with no new use until upgrade:\n${textList(d.freezeItems)}\n` : ""}
${d.revertItems.length ? `Reverted:\n${textList(d.revertItems)}\n` : ""}
Everything else keeps working as it did.

Open the workspace:
${d.workspaceUrl}

The dembrane team`,
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
  subject: string,
  t: SupportTemplate,
): RenderedEmail {
  const ws = EM(workspaceName);
  const name = esc(workspaceName);
  switch (t.kind) {
    case "request":
      return {
        subject,
        text: "",
        html: layout({
          title: `dembrane staff requested access to ${name}`,
          preview: `${esc(t.staffName)} asked to join ${name} for support.`,
          heading: "Staff access request",
          body: P(
            17,
            "0 0 28px",
            `${esc(t.staffName)} from dembrane asked to join ${ws} to help with support.\n  ${t.note ? `Their note: ${esc(t.note)}.` : ""}\n  If you approve, their access ends automatically after 24 hours.`,
          ),
          cta: cta("Review request", t.settingsUrl),
        }),
      };
    case "joined":
      return {
        subject,
        text: "",
        html: layout({
          title: `dembrane staff joined ${name} for support`,
          preview: `${esc(t.staffName)} joined ${name} to help with support.`,
          heading: "Staff joined for support",
          body: P(
            17,
            "0 0 28px",
            `${esc(t.staffName)} from dembrane joined ${ws} to help with support.\n  Their access ends automatically after 24 hours. You can follow what happens in the access history in your workspace settings.`,
          ),
          cta: cta("View access history", t.settingsUrl),
        }),
      };
    case "ended":
      return {
        subject,
        text: "",
        html: layout({
          title: `Support access to ${name} turned off`,
          preview: `The support session in ${name} ended and staff access was turned off.`,
          heading: "Support session ended",
          body: P(
            17,
            "0 0 28px",
            `The support session in ${ws} ended and staff access was turned off.\n  Turn it back on in workspace settings if you need more help.`,
          ),
          cta: cta("Open workspace settings", t.settingsUrl),
        }),
      };
    case "reminder":
      return {
        subject,
        text: "",
        html: layout({
          title: `Support access to ${name} is still on`,
          preview: `No staff joined ${name} in the last 7 days.`,
          heading: "Support access is still on",
          body: P(
            17,
            "0 0 28px",
            `Support access for ${ws} is still on and no staff joined in the last 7 days.\n  Turn it off in workspace settings if you no longer need help. You can turn it back on at any time.`,
          ),
          cta: cta("Open workspace settings", t.settingsUrl),
        }),
      };
    case "resolved":
      return {
        subject,
        text: "",
        html: layout({
          title: `Access request for ${name} ${t.decision}`,
          preview: `Your access request for ${name} was ${t.decision}.`,
          heading: `Request ${t.decision}`,
          body: P(
            17,
            "0 0 28px",
            `Your access request for ${ws} was ${t.decision}.\n  ${t.decision === "approved" ? "You have admin access for 24 hours." : ""}`,
          ),
          ...(t.decision === "approved" && { cta: cta("Open workspace", t.workspaceUrl) }),
        }),
      };
  }
}
