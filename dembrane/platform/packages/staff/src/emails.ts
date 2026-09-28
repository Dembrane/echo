import { emailLayout, emailStyles, type RenderedEmail } from "@dembrane/billing";
import { translator } from "@dembrane/i18n";
import { escapeHtml } from "@dembrane/mail";

type Kind =
  | "support_access_request"
  | "support_access_joined"
  | "support_access_ended"
  | "support_access_reminder"
  | "support_access_request_resolved";

const P =
  'style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;"';
const em = (s: string) => `<em ${emailStyles.EM}>${escapeHtml(s)}</em>`;

/**
 * The support access emails (old support_access_*.html), worded from the server catalog
 * (@dembrane/i18n, the email.support_* ids tenancy shares) in the recipient's language.
 * These templates had no text version; the text part here is the body copy, so every
 * client has something to show. English renders as before.
 */
export function supportEmail(
  kind: Kind,
  d: Record<string, string>,
  locale?: string | null,
): RenderedEmail {
  const tr = translator(locale);
  const ws = d.workspace_name ?? "";
  const staff = d.staff_name ?? "";
  const signoff = tr("email.common.signoff");
  const plain = { workspace_name: ws, staff_name: staff };
  const html = { workspace_name: em(ws), staff_name: escapeHtml(staff) };
  const head = (k: string) => ({
    title: tr(`${k}.subject`, plain),
    preview: tr(`${k}.preview`, plain),
    heading: tr(`${k}.heading`),
    signoff,
  });
  switch (kind) {
    case "support_access_request": {
      const k = "email.support_request";
      const note = d.note ? tr(`${k}.note`, { note: d.note }) : "";
      const body = `${tr(`${k}.body`, plain)} ${note} ${tr(`${k}.end`)}`;
      return {
        subject: tr(`${k}.subject`, plain),
        html: emailLayout({
          ...head(k),
          bodyHtml: `<p ${P}>${tr(`${k}.body`, html)} ${d.note ? tr(`${k}.note`, { note: escapeHtml(d.note) }) : ""} ${tr(`${k}.end`)}</p>`,
          cta: { label: tr(`${k}.cta`), url: d.settings_url ?? "" },
        }),
        text: `${body.replace(/\s+/g, " ")}\n\n${d.settings_url}\n\n${signoff}\n`,
      };
    }
    case "support_access_joined":
    case "support_access_ended":
    case "support_access_reminder": {
      const k =
        kind === "support_access_joined"
          ? "email.support_joined"
          : kind === "support_access_ended"
            ? "email.support_ended"
            : "email.support_reminder";
      const endText = kind === "support_access_ended" ? `${k}.end` : `${k}.end_text`;
      return {
        subject: tr(`${k}.subject`, plain),
        html: emailLayout({
          ...head(k),
          bodyHtml: `<p ${P}>${tr(`${k}.body`, html)} ${tr(`${k}.end`)}</p>`,
          cta: { label: tr(`${k}.cta`), url: d.settings_url ?? "" },
        }),
        text: `${tr(`${k}.body`, plain)} ${tr(endText)}\n\n${d.settings_url}\n\n${signoff}\n`,
      };
    }
    case "support_access_request_resolved": {
      const approved = d.decision === "approved";
      const k = approved ? "email.support_approved" : "email.support_denied";
      return {
        subject: tr(`${k}.subject`, plain),
        html: emailLayout({
          ...head(k),
          bodyHtml: `<p ${P}>${tr(`${k}.body`, html)} ${approved ? tr(`${k}.end`) : ""}</p>`,
          ...(approved && { cta: { label: tr(`${k}.cta`), url: d.workspace_url ?? "" } }),
        }),
        text: `${tr(`${k}.body`, plain)}${approved ? ` ${tr(`${k}.end`)}\n\n${d.workspace_url}` : ""}\n\n${signoff}\n`,
      };
    }
  }
}
