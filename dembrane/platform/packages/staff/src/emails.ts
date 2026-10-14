import { resolveLocale, translator } from "@dembrane/i18n";
import { email as e, emailFrame, escapeHtml, type RenderedEmail } from "@dembrane/mail";

type Kind =
  | "support_access_request"
  | "support_access_joined"
  | "support_access_ended"
  | "support_access_reminder"
  | "support_access_request_resolved";

const em = e.em;

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
    lang: resolveLocale(locale),
    title: tr(`${k}.subject`, plain),
    preview: tr(`${k}.preview`, plain),
    heading: tr(`${k}.heading`),
    signoff: { name: signoff },
  });
  const act = (label: string, url: string) => ({
    label,
    url,
    fallback: tr("email.common.fallback"),
  });
  switch (kind) {
    case "support_access_request": {
      const k = "email.support_request";
      const note = d.note ? tr(`${k}.note`, { note: d.note }) : "";
      const body = `${tr(`${k}.body`, plain)} ${note} ${tr(`${k}.end`)}`;
      return {
        subject: tr(`${k}.subject`, plain),
        html: emailFrame({
          ...head(k),
          body: e.lead(
            `${tr(`${k}.body`, html)} ${d.note ? tr(`${k}.note`, { note: escapeHtml(d.note) }) : ""} ${tr(`${k}.end`)}`,
          ),
          action: act(tr(`${k}.cta`), d.settings_url ?? ""),
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
        html: emailFrame({
          ...head(k),
          body: e.lead(`${tr(`${k}.body`, html)} ${tr(`${k}.end`)}`),
          action: act(tr(`${k}.cta`), d.settings_url ?? ""),
        }),
        text: `${tr(`${k}.body`, plain)} ${tr(endText)}\n\n${d.settings_url}\n\n${signoff}\n`,
      };
    }
    case "support_access_request_resolved": {
      const approved = d.decision === "approved";
      const k = approved ? "email.support_approved" : "email.support_denied";
      return {
        subject: tr(`${k}.subject`, plain),
        html: emailFrame({
          ...head(k),
          body: e.lead(`${tr(`${k}.body`, html)} ${approved ? tr(`${k}.end`) : ""}`),
          ...(approved && { action: act(tr(`${k}.cta`), d.workspace_url ?? "") }),
        }),
        text: `${tr(`${k}.body`, plain)}${approved ? ` ${tr(`${k}.end`)}\n\n${d.workspace_url}` : ""}\n\n${signoff}\n`,
      };
    }
  }
}
