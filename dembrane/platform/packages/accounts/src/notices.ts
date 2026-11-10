import { type EmailTemplate, render, sendEmail, subjectOf } from "@dembrane/account";
import type { Signed } from "@dembrane/http";
import type { z } from "zod";
import { assertPersonSends } from "./access";
import type {
  NoticeLanguage,
  NoticeRecipient,
  SubprocessorNoticeRequest,
  SubprocessorNoticeResponse,
} from "./contract";
import type { AccountsDeps } from "./deps";
import { emit } from "./events";
import { accountRecipients } from "./recipients";
import { store } from "./storage";

type Language = z.output<typeof NoticeLanguage>;
type Recipient = z.output<typeof NoticeRecipient>;
/** A recipient with the ids of their organisations, for the timeline. */
type Addressee = Recipient & { orgIds: string[] };
type Request = z.output<typeof SubprocessorNoticeRequest>;
type Response = z.output<typeof SubprocessorNoticeResponse>;

/** The DPA on dembrane.com, in the reader's language. */
export const DPA_URL: Record<Language, string> = {
  "nl-NL": "https://dembrane.com/nl/legal/dpa",
  "en-US": "https://dembrane.com/legal/dpa",
};

/** What a sample (the dry run's preview, the test send) names as the organisation. */
const SAMPLE_ORG: Record<Language, string> = {
  "nl-NL": "Gemeente Voorbeeld",
  "en-US": "Example Council",
};

/** Dutch for anyone whose language is Dutch, English for everyone else. */
const noticeLanguage = (language: string): Language =>
  language.toLowerCase().startsWith("nl") ? "nl-NL" : "en-US";

/** Organisations read at a time while collecting the audience. */
const BATCH = 8;

/**
 * Everyone who runs a live organisation (accountRecipients: owners, admins, billing with
 * an address), once per address however many organisations they run, with those
 * organisations' names. The language is the one accountRecipients gives the person in the
 * first of their organisations by name.
 */
export async function noticeAudience(d: AccountsDeps): Promise<Addressee[]> {
  const orgs = await store.liveOrgs(d.db);
  const byAddress = new Map<string, Addressee>();
  for (let i = 0; i < orgs.length; i += BATCH) {
    const batch = orgs.slice(i, i + BATCH);
    const found = await Promise.all(batch.map((o) => accountRecipients(d.db, o.id)));
    for (const [j, people] of found.entries()) {
      const o = batch[j] as (typeof batch)[number];
      for (const r of people) {
        const address = r.email.trim().toLowerCase();
        const known = byAddress.get(address);
        if (known) {
          known.orgs.push(o.name);
          known.orgIds.push(o.id);
        } else
          byAddress.set(address, {
            to: r.email.trim(),
            language: noticeLanguage(r.language),
            orgs: [o.name],
            orgIds: [o.id],
          });
      }
    }
  }
  return [...byAddress.values()].sort((a, b) => a.to.localeCompare(b.to));
}

function template(m: Request, language: Language, orgs: readonly string[]): EmailTemplate {
  return {
    template: "account_subprocessor_notice",
    data: {
      org_names: orgs.join("\n"),
      effective_date: m.effective_date,
      objection_deadline: m.objection_deadline,
      dpa_url: DPA_URL[language],
    },
  };
}

function rendered(t: EmailTemplate, to: string, language: Language) {
  return { to, language, subject: subjectOf(t, language) ?? "", ...render(t, language) };
}

const counts = (rs: readonly { language: Language }[]) => {
  const nl = rs.filter((r) => r.language === "nl-NL").length;
  return { nl, en: rs.length - nl, total: rs.length };
};

/**
 * dembrane's notice of a change to its sub-processors (DPA article 9.2) to the people who
 * run every live organisation: a dry run by default, a test send of both languages to one
 * address, or, confirmed, one email to every address. Each email is queued with a workflow
 * id of the notice's effective date and the address, so asking again never sends twice.
 * The send is recorded on each organisation's timeline as a message sent.
 */
export async function sendSubprocessorNotice(
  d: AccountsDeps,
  who: Signed,
  m: Request,
): Promise<Response> {
  if (!m.dry_run) assertPersonSends(who);
  const languages: Language[] = ["nl-NL", "en-US"];
  const sampleTemplates = languages.map((l) => ({ l, t: template(m, l, [SAMPLE_ORG[l]]) }));
  const replyTo = m.reply_to ? { email: m.reply_to, name: "dembrane" } : undefined;
  const context = `subprocessor notice ${m.effective_date}`;

  if (!m.dry_run && m.test_to) {
    const to = m.test_to;
    const samples = sampleTemplates.map(({ l, t }) => rendered(t, to, l));
    for (const [i, { l, t }] of sampleTemplates.entries())
      await d.jobs.enqueue(sendEmail, {
        to,
        subject: samples[i]?.subject ?? "",
        template: t.template,
        data: t.data as unknown as Record<string, string>,
        language: l,
        context: `${context} (test)`,
        ...(replyTo && { replyTo }),
      });
    const recipients = languages.map((l) => ({ to, language: l, orgs: [SAMPLE_ORG[l]] }));
    return { queued: samples.length, counts: counts(recipients), recipients, samples };
  }

  const audience = await noticeAudience(d);
  const recipients = audience.map(({ orgIds: _, ...r }) => r);
  const samples = sampleTemplates.map(({ l, t }) => rendered(t, "", l));
  const answer = { counts: counts(recipients), recipients, samples };
  if (m.dry_run || !audience.length) return { queued: 0, ...answer };

  const subject = { type: "notice", id: `subprocessors:${m.effective_date}` };
  await d.db.transaction(async (tx) => {
    const byOrg = new Map<string, string[]>();
    for (const r of audience) {
      const t = template(m, r.language, r.orgs);
      await d.jobs.enqueue(
        sendEmail,
        {
          to: r.to,
          subject: subjectOf(t, r.language) ?? "",
          template: t.template,
          data: t.data as unknown as Record<string, string>,
          language: r.language,
          context,
          ...(replyTo && { replyTo }),
        },
        {
          tx,
          workflowId: `accounts.notice:subprocessors:${m.effective_date}:${r.to.toLowerCase()}`,
        },
      );
      for (const id of r.orgIds) byOrg.set(id, [...(byOrg.get(id) ?? []), r.to]);
    }
    for (const [orgId, to] of byOrg)
      await emit(d, tx, {
        orgId,
        actor: { kind: "staff", userId: who.directusUserId },
        type: "message.sent",
        subject,
        detail: {
          kind: "subprocessor_notice",
          effective_date: m.effective_date,
          objection_deadline: m.objection_deadline,
          to,
        },
      });
  });
  return { queued: audience.length, ...answer };
}
