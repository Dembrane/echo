import { emailLayout, emailStyles, type RenderedEmail } from "@dembrane/billing";
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
 * The support access emails (old support_access_*.html). These templates had no text
 * version; the text part here is the body copy, so every client has something to show.
 */
export function supportEmail(kind: Kind, d: Record<string, string>): RenderedEmail {
  const ws = d.workspace_name ?? "";
  const staff = d.staff_name ?? "";
  const subject = d.subject ?? "";
  switch (kind) {
    case "support_access_request": {
      const note = d.note ? `Their note: ${d.note}.` : "";
      const body = `${staff} from dembrane asked to join ${ws} to help with support. ${note} If you approve, their access ends automatically after 24 hours.`;
      return {
        subject,
        html: emailLayout({
          title: subject,
          preview: `${staff} asked to join ${ws} for support.`,
          heading: "Staff access request",
          bodyHtml: `<p ${P}>${escapeHtml(staff)} from dembrane asked to join ${em(ws)} to help with support. ${note ? escapeHtml(note) : ""} If you approve, their access ends automatically after 24 hours.</p>`,
          cta: { label: "Review request", url: d.settings_url ?? "" },
        }),
        text: `${body.replace(/\s+/g, " ")}\n\n${d.settings_url}\n\nThe dembrane team\n`,
      };
    }
    case "support_access_joined":
      return {
        subject,
        html: emailLayout({
          title: `dembrane staff joined ${ws} for support`,
          preview: `${staff} joined ${ws} to help with support.`,
          heading: "Staff joined for support",
          bodyHtml: `<p ${P}>${escapeHtml(staff)} from dembrane joined ${em(ws)} to help with support. Their access ends automatically after 24 hours. You can follow what happens in the access history in your workspace settings.</p>`,
          cta: { label: "View access history", url: d.settings_url ?? "" },
        }),
        text: `${staff} from dembrane joined ${ws} to help with support. Their access ends automatically after 24 hours.\n\n${d.settings_url}\n\nThe dembrane team\n`,
      };
    case "support_access_ended":
      return {
        subject,
        html: emailLayout({
          title: subject,
          preview: `The support session in ${ws} ended and staff access was turned off.`,
          heading: "Support session ended",
          bodyHtml: `<p ${P}>The support session in ${em(ws)} ended and staff access was turned off. Turn it back on in workspace settings if you need more help.</p>`,
          cta: { label: "Open workspace settings", url: d.settings_url ?? "" },
        }),
        text: `The support session in ${ws} ended and staff access was turned off. Turn it back on in workspace settings if you need more help.\n\n${d.settings_url}\n\nThe dembrane team\n`,
      };
    case "support_access_reminder":
      return {
        subject,
        html: emailLayout({
          title: subject,
          preview: `No staff joined ${ws} in the last 7 days.`,
          heading: "Support access is still on",
          bodyHtml: `<p ${P}>Support access for ${em(ws)} is still on and no staff joined in the last 7 days. Turn it off in workspace settings if you no longer need help. You can turn it back on at any time.</p>`,
          cta: { label: "Open workspace settings", url: d.settings_url ?? "" },
        }),
        text: `Support access for ${ws} is still on and no staff joined in the last 7 days. Turn it off in workspace settings if you no longer need help.\n\n${d.settings_url}\n\nThe dembrane team\n`,
      };
    case "support_access_request_resolved": {
      const approved = d.decision === "approved";
      return {
        subject,
        html: emailLayout({
          title: subject,
          preview: `Your access request for ${ws} was ${d.decision}.`,
          heading: `Request ${d.decision}`,
          bodyHtml: `<p ${P}>Your access request for ${em(ws)} was ${escapeHtml(d.decision ?? "")}. ${approved ? "You have admin access for 24 hours." : ""}</p>`,
          ...(approved && { cta: { label: "Open workspace", url: d.workspace_url ?? "" } }),
        }),
        text: `Your access request for ${ws} was ${d.decision}.${approved ? ` You have admin access for 24 hours.\n\n${d.workspace_url}` : ""}\n\nThe dembrane team\n`,
      };
    }
  }
}
