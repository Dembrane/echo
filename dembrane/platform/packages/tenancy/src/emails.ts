import { type MessageParams, resolveLocale, type Translate, translator } from "@dembrane/i18n";
import { email as e, emailFrame, emailText, escapeHtml, type RenderedEmail } from "@dembrane/mail";

/**
 * The transactional emails this namespace sends, in the recipient's language: every
 * sentence comes from the server catalog (@dembrane/i18n). English renders to the same
 * subject, HTML and text as the old API's Jinja templates (server/email_templates). HTML
 * values are escaped; the text part is not, matching Jinja's autoescape rules.
 */

export type { RenderedEmail } from "@dembrane/mail";

const esc = (v: unknown) => escapeHtml(String(v ?? ""));
const EM = e.em;

/** Escapes every value, for the parts of the HTML that show values as plain text. */
const escAll = (d: MessageParams) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, esc(v)]));

/** The shared frame of @dembrane/mail, worded in `tr`'s language. */
function layout(
  tr: Translate,
  locale: string | null | undefined,
  b: {
    title: string;
    preview: string;
    heading: string;
    body: string;
    cta?: { label: string; url: string };
    ignore?: boolean;
  },
): string {
  return emailFrame({
    lang: resolveLocale(locale),
    title: b.title,
    preview: b.preview,
    heading: b.heading,
    body: b.body,
    ...(b.cta && { action: { ...b.cta, fallback: tr("email.common.fallback") } }),
    ...(b.ignore && { after: e.note(tr("email.common.ignore")) }),
    signoff: { name: tr("email.common.signoff") },
  });
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
    html: layout(tr, locale, {
      title: tr(`${k}.subject`, p),
      preview: tr(`${k}.preview`, p),
      heading: tr(`${k}.heading`, p),
      body: `${e.lead(tr(bodyKey, { ...escAll(p), org_name: EM(d.orgName), role: EM(d.role) }))}\n${e.p(tr(`${k}.next`))}`,
      cta: { label: tr(`${k}.cta`), url: d.inviteUrl },
      ignore: true,
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
    html: layout(tr, locale, {
      title: tr(`${k}.title`),
      preview: tr(`${k}.preview`, p),
      heading: tr(`${k}.heading`),
      body: e.lead(tr(`${k}.body`, { ...escAll(p), workspace_name: EM(d.workspaceName) })),
      cta: { label: tr(`${k}.cta`), url: d.inviteUrl },
      ignore: true,
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
  const body = [
    e.lead(tr(`${k}.body`, { ...escAll(p), workspace_name: EM(d.workspaceName) })),
    d.freezeItems.length ? `${e.p(tr(`${k}.frozen`))}${e.list(d.freezeItems)}` : "",
    d.revertItems.length ? `${e.p(tr(`${k}.reverted`))}${e.list(d.revertItems)}` : "",
    e.p(tr(`${k}.rest`)),
  ]
    .filter(Boolean)
    .join("\n\n");
  const textList = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  return {
    subject: tr(`${k}.subject`, p).replace(/[\r\n]/g, " "),
    html: layout(tr, locale, {
      title: tr(`${k}.subject`, p),
      preview: tr(`${k}.preview`, p),
      heading: tr(`${k}.heading`, p),
      body,
      cta: { label: tr(`${k}.cta`), url: d.workspaceUrl },
    }),
    text: emailText([
      tr(`${k}.text_body`, p),
      d.freezeItems.length > 0 && `${tr(`${k}.frozen_text`)}\n${textList(d.freezeItems)}`,
      d.revertItems.length > 0 && `${tr(`${k}.reverted_text`)}\n${textList(d.revertItems)}`,
      tr(`${k}.rest_text`),
      `${tr(`${k}.text_cta`)}\n${d.workspaceUrl}`,
      tr("email.common.signoff"),
    ]),
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
    title: tr(`${k}.subject`, plain),
    preview: tr(`${k}.preview`, plain),
    heading: tr(`${k}.heading`),
  };
  const subject = tr(`${k}.subject`, plain);
  switch (t.kind) {
    case "request":
      return {
        subject,
        text: "",
        html: layout(tr, locale, {
          ...head,
          body: e.lead(
            `${tr(`${k}.body`, inBody)}\n  ${t.note ? tr(`${k}.note`, { note: esc(t.note) }) : ""}\n  ${tr(`${k}.end`)}`,
          ),
          cta: { label: tr(`${k}.cta`), url: t.settingsUrl },
        }),
      };
    case "joined":
    case "ended":
    case "reminder":
      return {
        subject,
        text: "",
        html: layout(tr, locale, {
          ...head,
          body: e.lead(`${tr(`${k}.body`, inBody)}\n  ${tr(`${k}.end`)}`),
          cta: { label: tr(`${k}.cta`), url: t.settingsUrl },
        }),
      };
    case "resolved":
      return {
        subject,
        text: "",
        html: layout(tr, locale, {
          ...head,
          body: e.lead(
            `${tr(`${k}.body`, inBody)}\n  ${t.decision === "approved" ? tr(`${k}.end`) : ""}`,
          ),
          ...(t.decision === "approved" && { cta: { label: tr(`${k}.cta`), url: t.workspaceUrl } }),
        }),
      };
  }
}
