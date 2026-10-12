/**
 * Transactional emails of the account area, in the shared frame of @dembrane/mail
 * (brand/CALL_TO_CASH.md). Every sentence comes from the server catalog (@dembrane/i18n,
 * packages/i18n/locales) in the recipient's language. Values shown inside sentences are
 * escaped here; the text part is sent alongside every HTML part.
 */
import { resolveLocale, type Translate, translator } from "@dembrane/i18n";
import { email as e, emailFrame, emailText, escapeHtml as esc } from "@dembrane/mail";

export type { RenderedEmail } from "@dembrane/mail";

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
  | { readonly template: "reset_password"; readonly data: { reset_url: string } }
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
      readonly template: "account_invite";
      readonly data: { org_name: string; sign_in_url: string };
    }
  | {
      readonly template: "account_offer_sent";
      readonly data: OfferSentData;
    }
  | { readonly template: "account_invoice_issued"; readonly data: InvoiceIssuedData }
  | { readonly template: "account_document_withdrawn"; readonly data: DocumentWithdrawnData }
  | { readonly template: "account_task_reminder"; readonly data: TaskReminderData }
  | {
      readonly template: "report_published";
      readonly data: {
        portal_url: string;
        project_id: string;
        token: string;
        conversation_name: string;
      };
    }
  | { readonly template: "plain"; readonly data: { text: string } };

/**
 * The offer email's data. Everything past sign_url is optional: jobs queued before those
 * fields existed render without the facts and signed by the team.
 */
export interface OfferSentData {
  org_name: string;
  document_title: string;
  sign_url: string;
  /** The offer's reference, e.g. "OFF-2026-014". */
  reference?: string;
  /** The total including VAT, in cents, with its currency code. An offer always has one. */
  total_cents: string;
  currency: string;
  /** ISO date the offer is valid until. */
  valid_until?: string;
  /** Who at dembrane owns the account: signs the email and gets the replies. */
  manager_name?: string;
}

/**
 * What every message sam asks echo to send carries (POST .../messages): the account, where
 * its page is, who at dembrane signs, and an optional line of their own. sam decides when
 * to write; echo decides how it looks and words everything but `note`, which sam writes in
 * the recipient's language.
 */
interface SamMessageData {
  org_name: string;
  account_url: string;
  manager_name?: string;
  note?: string;
}

export interface InvoiceIssuedData extends SamMessageData {
  reference?: string;
  total_cents?: string;
  currency?: string;
  /** ISO dates. */
  issued_on?: string;
  due_on?: string;
  /** The payment link (Mollie), when the invoice can be paid online. */
  pay_url?: string;
}

export interface DocumentWithdrawnData extends SamMessageData {
  document_title: string;
}

export interface TaskReminderData extends SamMessageData {
  /** The task's title and explanation, already worded in the recipient's language. */
  task_title: string;
  task_body?: string;
}

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
    case "reset_password":
      return tr("email.reset_password.subject");
    case "sign_in_code":
      return tr("email.sign_in_code.subject");
    case "account_signer_invite":
      return tr("email.account_signer_invite.subject", t.data);
    case "account_invite":
      return tr("email.account_invite.subject", t.data);
    case "account_offer_sent":
      return tr("email.account_offer_sent.subject", { document_title: t.data.document_title });
    case "account_invoice_issued":
      return tr("email.account_invoice_issued.subject", { org_name: t.data.org_name });
    case "account_document_withdrawn":
      return tr("email.account_document_withdrawn.subject", {
        document_title: t.data.document_title,
      });
    case "account_task_reminder":
      return tr("email.account_task_reminder.subject", {
        org_name: t.data.org_name,
        task_title: t.data.task_title,
      });
    case "report_published":
      return tr("email.report_published.subject");
    case "plain":
      return null;
  }
}

/** Escapes every value, for the parts of the HTML that show values as plain text. */
const escAll = (d: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, esc(v ?? "")]));

/** What every frame in one language shares: the team signs, the link is written out. */
const common = (tr: Translate, locale: string) => ({
  lang: resolveLocale(locale),
  signoff: { name: tr("email.common.signoff") },
  fallback: tr("email.common.fallback"),
});

/**
 * Renders the body of an email in `locale` (any stored language value; English when
 * absent). The subject comes from subjectOf.
 */
export function render(t: EmailTemplate, locale?: string | null): { html: string; text: string } {
  const tr = translator(locale);
  const lang = resolveLocale(locale);
  const c = common(tr, lang);
  const signoff = c.signoff.name;
  const ignore = e.note(tr("email.common.ignore"));
  const ignoreText = tr("email.common.ignore_text");
  const act = (label: string, url: string) => ({ label, url, fallback: c.fallback });
  switch (t.template) {
    case "workspace_invite": {
      const d = t.data;
      const k = "email.workspace_invite";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.title`),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`),
          body: e.lead(tr(`${k}.body`, { ...escAll(d), workspace_name: e.em(d.workspace_name) })),
          action: act(tr(`${k}.cta`), d.invite_url),
          after: ignore,
        }),
        text: emailText([
          tr(`${k}.body`, d),
          `${tr(`${k}.text_cta`)}\n${d.invite_url}`,
          ignoreText,
          signoff,
        ]),
      };
    }
    case "workspace_added": {
      const d = t.data;
      const k = "email.workspace_added";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`, d),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`),
          body: e.lead(tr(`${k}.body`, { ...escAll(d), workspace_name: e.em(d.workspace_name) })),
          action: act(tr(`${k}.cta`), d.invite_url),
        }),
        text: emailText([tr(`${k}.body`, d), `${tr(`${k}.text_cta`)}\n${d.invite_url}`, signoff]),
      };
    }
    case "org_invite": {
      const d = t.data;
      const k = "email.org_invite";
      const asRole = d.role && d.role !== "member";
      const bodyKey = asRole ? `${k}.body_role` : `${k}.body`;
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`, d),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`, d),
          body: `${e.lead(tr(bodyKey, { ...escAll(d), org_name: e.em(d.org_name), role: e.em(d.role) }))}${e.p(tr(`${k}.next`))}`,
          action: act(tr(`${k}.cta`), d.invite_url),
          after: ignore,
        }),
        text: emailText([
          tr(bodyKey, d),
          `${tr(`${k}.text_cta`)}\n${d.invite_url}`,
          tr(`${k}.next`),
          ignoreText,
          signoff,
        ]),
      };
    }
    case "registration_existing_account": {
      const d = t.data;
      const k = "email.registration_existing_account";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`),
          heading: tr(`${k}.heading`),
          body: e.lead(tr(`${k}.body`)),
          action: act(tr(`${k}.cta`), d.login_url),
          after: `${e.note(tr(`${k}.reset`, { reset_link: e.link(d.reset_url, tr(`${k}.reset_link`)) }))}${e.note(tr(`${k}.ignore`))}`,
        }),
        text: emailText([
          tr(`${k}.heading`),
          tr(`${k}.body`),
          `${tr(`${k}.text_cta`)}\n${d.login_url}`,
          `${tr(`${k}.reset_text`)}\n${d.reset_url}`,
          tr(`${k}.ignore`),
          signoff,
        ]),
      };
    }
    case "verify_email":
    case "reset_password": {
      const d = t.data;
      const k = `email.${t.template}`;
      const url = "verify_url" in d ? d.verify_url : d.reset_url;
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`),
          heading: tr(`${k}.heading`),
          body: e.lead(tr(`${k}.body`)),
          action: act(tr(`${k}.cta`), url),
          after: e.note(tr(`${k}.ignore`)),
        }),
        text: emailText([
          tr(`${k}.heading`),
          `${tr(`${k}.text_cta`)}\n${url}`,
          tr(`${k}.ignore`),
          signoff,
        ]),
      };
    }
    case "sign_in_code": {
      // Part of the offer flow too: a signer who has no account signs in with this code.
      const d = t.data;
      const k = "email.sign_in_code";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`),
          body: `${e.p(tr(`${k}.lead`))}${e.code(d.code)}${e.p(tr(`${k}.expires`))}`,
          after: e.note(tr(`${k}.ignore`)),
        }),
        text: emailText([tr(`${k}.text_body`, d), tr(`${k}.ignore`), signoff]),
      };
    }
    case "account_signer_invite": {
      // Someone named as the signer of one document: the link signs them in with a
      // one-time code and opens only that document.
      const d = t.data;
      const k = "email.account_signer_invite";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`, d),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`, d),
          body: `${e.lead(tr(`${k}.body`, { ...escAll(d), document_title: e.em(d.document_title) }))}${e.p(tr(`${k}.how`))}`,
          action: act(tr(`${k}.cta`), d.sign_url),
          after: `${e.note(tr(`${k}.wrong_person`, escAll(d)))}${ignore}`,
          footer: tr(`${k}.footer`, escAll(d)),
        }),
        text: emailText([
          tr(`${k}.heading`, d),
          tr(`${k}.body`, d),
          tr(`${k}.how`),
          `${tr(`${k}.text_cta`)}\n${d.sign_url}`,
          tr(`${k}.wrong_person`, d),
          ignoreText,
          signoff,
        ]),
      };
    }
    case "account_invite": {
      // The contact of a demo made in echo, invited when staff publish it.
      const d = t.data;
      const k = "email.account_invite";
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`, d),
          preview: tr(`${k}.preview`, d),
          heading: tr(`${k}.heading`),
          body: `${e.lead(tr(`${k}.body`, { org_name: e.em(d.org_name) }))}${e.p(tr(`${k}.how`))}`,
          action: act(tr(`${k}.cta`), d.sign_in_url),
          after: ignore,
          footer: tr(`${k}.footer`, escAll(d)),
        }),
        text: emailText([
          tr(`${k}.heading`),
          tr(`${k}.body`, d),
          tr(`${k}.how`),
          `${tr(`${k}.text_cta`)}\n${d.sign_in_url}`,
          ignoreText,
          signoff,
        ]),
      };
    }
    case "account_offer_sent": {
      // To the people who run the account, when staff send it an offer. The link opens the
      // offer where it is read and signed; someone signed out signs in first. Signed by the
      // account's manager when it has one, and replies reach them (see the job's replyTo).
      const d = t.data;
      const v = { org_name: d.org_name, document_title: d.document_title };
      const k = "email.account_offer_sent";
      const total = e.money(Number(d.total_cents), d.currency, lang);
      const facts = [
        { label: tr("email.facts.offer"), value: d.document_title },
        { label: tr("email.facts.reference"), value: d.reference ?? "" },
        {
          label: tr("email.facts.valid_until"),
          value: d.valid_until ? e.day(d.valid_until, lang) : "",
        },
        { label: tr("email.facts.total"), value: total, strong: true },
      ];
      const manager = d.manager_name?.trim();
      const questions = manager ? tr("email.common.reply_to", { name: manager }) : null;
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`, v),
          preview: tr(`${k}.preview`, v),
          heading: tr(`${k}.heading`),
          body: `${e.lead(tr(`${k}.body`, { org_name: esc(d.org_name) }))}${e.facts(facts)}${e.p(tr(`${k}.signer`, { org_name: esc(d.org_name) }))}`,
          action: act(tr(`${k}.cta`), d.sign_url),
          ...(questions && { after: e.note(esc(questions)) }),
          signoff: manager ? { name: manager, role: "dembrane" } : c.signoff,
          footer: tr("email.common.footer_account", escAll(v)),
        }),
        text: emailText([
          tr(`${k}.heading`),
          tr(`${k}.body`, v),
          facts
            .filter((f) => f.value)
            .map((f) => `${f.label}: ${f.value}`)
            .join("\n"),
          tr(`${k}.signer`, v),
          `${tr(`${k}.text_cta`)}\n${d.sign_url}`,
          questions,
          manager ? `${manager}\ndembrane` : signoff,
        ]),
      };
    }
    case "account_invoice_issued":
    case "account_document_withdrawn":
    case "account_task_reminder":
      return samMessage(t, tr, lang, c);
    case "report_published": {
      // To participants who asked on the portal to hear when the report is published.
      const d = t.data;
      const k = "email.report_published";
      const base = `${d.portal_url}/${lang}/${encodeURIComponent(d.project_id)}`;
      const reportUrl = `${base}/report`;
      const unsubscribeUrl = `${base}/unsubscribe?${new URLSearchParams({ token: d.token, project_id: d.project_id })}`;
      const heading = d.conversation_name
        ? tr(`${k}.heading_named`, { conversation_name: d.conversation_name })
        : tr(`${k}.heading`);
      return {
        html: emailFrame({
          ...c,
          title: tr(`${k}.subject`),
          preview: tr(`${k}.preview`),
          heading,
          body: e.lead(tr(`${k}.body`)),
          action: act(tr(`${k}.cta`), reportUrl),
          footer: tr(`${k}.unsubscribe`, {
            unsubscribe_link: e.link(unsubscribeUrl, tr(`${k}.unsubscribe_link`)),
          }),
        }),
        text: emailText([
          heading,
          tr(`${k}.body`),
          `${tr(`${k}.text_cta`)}\n${reportUrl}`,
          `${tr(`${k}.unsubscribe_text`)}\n${unsubscribeUrl}`,
          signoff,
        ]),
      };
    }
    case "plain":
      return {
        html: `<pre style="font-family:inherit; white-space:pre-wrap;">${esc(t.data.text)}</pre>`,
        text: t.data.text,
      };
  }
}

type SamTemplate = Extract<
  EmailTemplate,
  {
    template: "account_invoice_issued" | "account_document_withdrawn" | "account_task_reminder";
  }
>;

/**
 * The messages sam asks for (see SamMessageData): one shape for all three. The manager
 * signs and gets the replies; sam's own line, when it wrote one, follows the opening.
 */
function samMessage(
  t: SamTemplate,
  tr: Translate,
  lang: string,
  c: ReturnType<typeof common>,
): { html: string; text: string } {
  const d = t.data;
  const k = `email.${t.template}`;
  const manager = d.manager_name?.trim();
  const questions = manager ? tr("email.common.reply_to", { name: manager }) : null;
  const note = d.note?.trim();
  let lead = "";
  let leadText = "";
  let block = "";
  let blockText: string | null = null;
  let action = {
    label: tr("email.common.cta_account"),
    text: tr("email.common.text_cta_account"),
    url: d.account_url,
  };
  let heading = tr(`${k}.heading`);
  switch (t.template) {
    case "account_invoice_issued": {
      const i = t.data;
      const facts = [
        { label: tr("email.facts.invoice"), value: i.reference ?? "" },
        { label: tr("email.facts.issued"), value: i.issued_on ? e.day(i.issued_on, lang) : "" },
        { label: tr("email.facts.due"), value: i.due_on ? e.day(i.due_on, lang) : "" },
        {
          label: tr("email.facts.total"),
          value:
            i.total_cents && i.currency ? e.money(Number(i.total_cents), i.currency, lang) : "",
          strong: true,
        },
      ];
      lead = tr(`${k}.body`, { org_name: esc(i.org_name) });
      leadText = tr(`${k}.body`, { org_name: i.org_name });
      block = e.facts(facts);
      blockText = facts
        .filter((f) => f.value)
        .map((f) => `${f.label}: ${f.value}`)
        .join("\n");
      if (i.pay_url)
        action = { label: tr(`${k}.cta_pay`), text: tr(`${k}.text_cta_pay`), url: i.pay_url };
      break;
    }
    case "account_document_withdrawn": {
      const w = t.data;
      heading = tr(`${k}.heading`, { document_title: w.document_title });
      lead = tr(`${k}.body`, { org_name: esc(w.org_name), document_title: e.em(w.document_title) });
      leadText = tr(`${k}.body`, { org_name: w.org_name, document_title: w.document_title });
      break;
    }
    case "account_task_reminder": {
      const r = t.data;
      lead = tr(`${k}.body`, { org_name: esc(r.org_name) });
      leadText = tr(`${k}.body`, { org_name: r.org_name });
      block = `${e.lead(e.em(r.task_title))}${r.task_body ? e.p(esc(r.task_body)) : ""}`;
      blockText = [r.task_title, r.task_body].filter(Boolean).join("\n");
      break;
    }
  }
  return {
    html: emailFrame({
      ...c,
      title: subjectOf(t, lang) ?? heading,
      preview: leadText,
      heading,
      body: `${e.lead(lead)}${note ? e.p(esc(note)) : ""}${block}`,
      action: { label: action.label, url: action.url, fallback: c.fallback },
      ...(questions && { after: e.note(esc(questions)) }),
      signoff: manager ? { name: manager, role: "dembrane" } : c.signoff,
      footer: tr("email.common.footer_account", { org_name: esc(d.org_name) }),
    }),
    text: emailText([
      heading,
      leadText,
      note,
      blockText,
      `${action.text}\n${action.url}`,
      questions,
      manager ? `${manager}\ndembrane` : c.signoff.name,
    ]),
  };
}
