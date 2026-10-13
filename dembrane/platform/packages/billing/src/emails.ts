import { type MessageParams, resolveLocale, translator } from "@dembrane/i18n";
import { email as e, emailFrame, emailText, escapeHtml, type RenderedEmail } from "@dembrane/mail";

/**
 * The billing emails, in the shared frame of @dembrane/mail (brand/CALL_TO_CASH.md). Every
 * sentence comes from the server catalog (@dembrane/i18n) in the recipient's language.
 */
export type { RenderedEmail } from "@dembrane/mail";

const escAll = (d: MessageParams) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, escapeHtml(String(v))]));

function frameOf(locale: string | null | undefined) {
  const tr = translator(locale);
  return {
    tr,
    base: {
      lang: resolveLocale(locale),
      signoff: { name: tr("email.common.signoff") },
    },
    act: (label: string, url: string) => ({ label, url, fallback: tr("email.common.fallback") }),
  };
}

export function paymentFailedEmail(billingUrl: string, locale?: string | null): RenderedEmail {
  const { tr, base, act } = frameOf(locale);
  const k = "email.payment_failed";
  return {
    subject: tr(`${k}.subject`),
    html: emailFrame({
      ...base,
      title: tr(`${k}.subject`),
      preview: tr(`${k}.preview`),
      heading: tr(`${k}.heading`),
      body: `${e.lead(tr(`${k}.body`))}${e.p(tr(`${k}.next`))}`,
      action: act(tr(`${k}.cta`), billingUrl),
    }),
    text: emailText([
      tr(`${k}.heading`),
      tr(`${k}.body`),
      tr(`${k}.next`),
      `${tr(`${k}.text_cta`)}\n${billingUrl}`,
      base.signoff.name,
    ]),
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
  const { tr, base, act } = frameOf(locale);
  const k = "email.tier_expired";
  const d = "email.tier_downgraded";
  const v = { workspace_name: p.workspaceName, from_tier: p.fromTier };
  let body = e.lead(
    tr(`${k}.body`, { from_tier: escapeHtml(p.fromTier), workspace_name: e.em(p.workspaceName) }),
  );
  if (p.freezeItems.length) body += `${e.p(tr(`${d}.frozen`))}${e.list(p.freezeItems)}`;
  if (p.revertItems.length) body += `${e.p(tr(`${d}.reverted`))}${e.list(p.revertItems)}`;
  body += e.p(tr(`${k}.rest`));
  const items = (title: string, xs: readonly string[]) =>
    xs.length ? `${title}\n${xs.map((i) => `- ${i}`).join("\n")}` : null;
  return {
    subject: tr(`${k}.subject`, v),
    html: emailFrame({
      ...base,
      title: tr(`${k}.subject`, v),
      preview: tr(`${k}.preview`, v),
      heading: tr(`${k}.heading`, v),
      body,
      action: act(tr(`${k}.cta`), p.workspaceUrl),
    }),
    text: emailText([
      tr(`${k}.text_body`, v),
      items(tr(`${d}.frozen_text`), p.freezeItems),
      items(tr(`${d}.reverted_text`), p.revertItems),
      tr(`${k}.rest`),
      `${tr(`${k}.text_cta`)}\n${p.workspaceUrl}`,
      base.signoff.name,
    ]),
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
  const { tr, base, act } = frameOf(locale);
  const k = "email.tier_expiring";
  const v = { workspace_name: p.workspaceName, tier: p.currentTier, date: p.expiresDate };
  const bodyV = { ...escAll(v), workspace_name: e.em(p.workspaceName) };
  return {
    subject: tr(`${k}.subject`, v),
    html: emailFrame({
      ...base,
      title: tr(`${k}.subject`, v),
      preview: tr(`${k}.preview`, v),
      heading: tr(`${k}.heading`, v),
      body: `${e.lead(tr(`${k}.body`, bodyV))}${e.p(tr(`${k}.rest`, escAll(v)))}`,
      action: act(tr(`${k}.cta`), p.workspaceUrl),
    }),
    text: emailText([
      tr(`${k}.text_body`, v),
      tr(`${k}.rest`, v),
      `${tr(`${k}.text_cta`)}\n${p.workspaceUrl}`,
      base.signoff.name,
    ]),
  };
}
