import { asset, color, font, space, type } from "./brand";
import { escapeHtml as esc } from "./mailer";

/**
 * The one frame every email dembrane sends is built in (brand/CALL_TO_CASH.md, "Emails"):
 * parchment behind a white card ruled top and bottom, the wordmark, a title, the body,
 * one pill, the sign-off, and a quiet footer under the card. Tables and inline styles
 * only, so Outlook, Gmail and Apple Mail draw the same thing; no images but the wordmark,
 * so a client that blocks images loses nothing but the logo.
 *
 * Values are escaped by the helpers below (`em`, `facts`, `list`, `link`); `body` and the
 * `html` arguments are trusted HTML the templates build from catalog sentences.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailFrame {
  /** The recipient's language tag, for screen readers and hyphenation. */
  readonly lang: string;
  /** The document title: the subject line. */
  readonly title: string;
  /** The inbox preview after the subject. Plain text. */
  readonly preview: string;
  /** What happened or what is asked, in one line. Plain text. */
  readonly heading: string;
  /** Trusted HTML: blocks made with the helpers below. */
  readonly body: string;
  /** The one thing to do, as a pill, with the link written out under it. */
  readonly action?: { readonly label: string; readonly url: string; readonly fallback: string };
  /** Trusted HTML after the action: what to do if this was not expected, and the like. */
  readonly after?: string;
  /** Who signs: a person ("Anna de Vries" / "dembrane") or the team. Plain text. */
  readonly signoff: { readonly name: string; readonly role?: string };
  /** Why this email came, under the card. Trusted HTML. */
  readonly footer?: string;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const BODY = `font-size:${px(type.screen.body)}; line-height:${type.leading.body}; color:${color.text}; font-weight:${font.emailWeight};`;
const CAPTION = `font-size:${px(type.screen.caption)}; line-height:${type.leading.body}; color:${color.muted}; font-weight:${font.emailWeight};`;
const RULE = `1px solid ${color.quiet}`;
const GUTTER = space[12];

/** A paragraph of running text. */
export const p = (html: string) => `<p style="margin:0 0 ${space[4]}px; ${BODY}">${html}</p>`;

/** The opening line, a step up the ladder: what this email is about, in a sentence. */
export const lead = (html: string) =>
  `<p style="margin:0 0 ${space[6]}px; font-size:${px(type.screen.lead)}; line-height:1.45; color:${color.text}; font-weight:${font.emailWeight};">${html}</p>`;

/** Small print: muted caption text. */
export const note = (html: string) => `<p style="margin:0 0 ${space[3]}px; ${CAPTION}">${html}</p>`;

/** A name or title worth finding in a sentence: blue, never bold. Escapes `v`. */
export const em = (v: string) => `<span style="color:${color.action};">${esc(v)}</span>`;

/** A link in running text. Escapes both. */
export const link = (url: string, label: string) =>
  `<a href="${esc(url)}" style="color:${color.action}; text-decoration:underline;">${esc(label)}</a>`;

/** A short list of things, e.g. the features a plan change touched. Escapes each item. */
export const list = (items: readonly string[]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 ${space[4]}px;">${items
    .map(
      (i) =>
        `<tr><td valign="top" width="20" style="${BODY} color:${color.muted};">&#8211;</td><td style="${BODY}">${esc(i)}</td></tr>`,
    )
    .join("")}</table>`;

/**
 * The facts of the thing the email is about (the offer, the plan) as a ruled list of
 * label and value: ruled above and below, because it is something to read. Values are
 * escaped; a value marked `strong` is the one figure that matters most (the total).
 */
export function facts(rows: readonly { label: string; value: string; strong?: boolean }[]) {
  const shown = rows.filter((r) => r.value);
  if (!shown.length) return "";
  const cells = shown
    .map(
      (r, i) =>
        `<tr><td valign="baseline" style="padding:${space[3]}px 0; ${i ? `border-top:${RULE};` : ""} ${CAPTION} width:40%;">${esc(r.label)}</td><td valign="baseline" align="right" style="padding:${space[3]}px 0; ${i ? `border-top:${RULE};` : ""} ${BODY}${r.strong ? ` font-size:${px(type.screen.lead)};` : ""}">${esc(r.value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 ${space[6]}px; border-top:${RULE}; border-bottom:${RULE};">${cells}</table>`;
}

function action(a: NonNullable<EmailFrame["action"]>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${space[2]}px 0 ${space[4]}px;"><tr><td style="border-radius:9999px; background-color:${color.action};"><a href="${esc(a.url)}" style="display:inline-block; padding:14px 28px; border-radius:9999px; background-color:${color.action}; color:${color.onFill}; font-family:${font.family}; font-size:${px(type.screen.body)}; font-weight:${font.emailWeight}; line-height:1; text-decoration:none;">${esc(a.label)}</a></td></tr></table>
${note(`${esc(a.fallback)}<br><a href="${esc(a.url)}" style="color:${color.action}; word-break:break-all;">${esc(a.url)}</a>`)}`;
}

/**
 * Zero-width padding after the preview text, so a client's inbox preview ends where the
 * preview does instead of running on into the heading.
 */
const PREVIEW_PAD = "&#847;&zwnj;&nbsp;".repeat(60);

export function emailFrame(f: EmailFrame): string {
  const sign = f.signoff.role
    ? `${esc(f.signoff.name)}<br><span style="color:${color.muted};">${esc(f.signoff.role)}</span>`
    : esc(f.signoff.name);
  return `<!DOCTYPE html>
<html lang="${esc(f.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(f.title)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300&display=swap');
body, table, td, a, p { font-feature-settings: ${font.features}; }
@media (max-width: 600px) {
  .card-pad { padding-left: ${space[6]}px !important; padding-right: ${space[6]}px !important; }
  .outer-pad { padding: ${space[4]}px ${space[2]}px !important; }
}
</style>
</head>
<body style="margin:0; padding:0; background-color:${color.parchment}; font-family:${font.family}; color:${color.text}; font-weight:${font.emailWeight}; -webkit-text-size-adjust:100%;">
<div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; color:${color.parchment};">${esc(f.preview)}${PREVIEW_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${color.parchment};">
<tr><td align="center" class="outer-pad" style="padding:${space[12]}px ${space[4]}px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td class="card-pad" style="background-color:${color.surface}; border-top:${RULE}; border-bottom:${RULE}; padding:${space[8]}px ${GUTTER}px ${space[8]}px; font-family:${font.family};">
<img src="${asset.wordmark}" alt="dembrane" width="118" height="24" border="0" style="display:block; width:118px; height:auto; border:0; outline:none; text-decoration:none;">
<h1 style="margin:${space[12]}px 0 ${space[6]}px; font-family:${font.family}; font-size:${px(type.screen.title)}; line-height:${type.leading.title}; font-weight:${font.emailWeight}; color:${color.text};">${esc(f.heading)}</h1>
${f.body}
${f.action ? action(f.action) : ""}
${f.after ?? ""}
<p style="margin:${space[8]}px 0 0; ${BODY}">${sign}</p>
</td></tr>
${f.footer ? `<tr><td class="card-pad" style="padding:${space[6]}px ${GUTTER}px 0; font-family:${font.family};">${note(f.footer)}</td></tr>` : ""}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The text part, in the same order as the HTML: heading, body, the action and its link,
 * what follows it, the sign-off. Blocks are separated by one blank line.
 */
export function emailText(parts: readonly (string | null | undefined | false)[]): string {
  return `${parts.filter((x): x is string => Boolean(x)).join("\n\n")}\n`;
}

/**
 * A code to type in, set apart so it can be read at a glance and copied: ruled above and
 * below like everything to read, a step up in size, spaced for reading aloud.
 */
export const code = (v: string) =>
  `<p style="margin:0 0 ${space[6]}px; padding:${space[4]}px 0; border-top:${RULE}; border-bottom:${RULE}; font-size:${px(type.screen.display)}; line-height:1; letter-spacing:0.12em; color:${color.text}; font-weight:${font.emailWeight}; font-variant-numeric:tabular-nums;">${esc(v)}</p>`;

/** dembrane writes British English, so English dates read "1 December 2026". */
const written = (locale: string) => (locale.startsWith("en") ? "en-GB" : locale);

/** An amount in the recipient's language: "€ 12.100,00" in Dutch, "€12,100.00" in English. */
export function money(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(written(locale), { style: "currency", currency }).format(
    cents / 100,
  );
}

/** A calendar date ("2026-12-01") as the recipient writes it: "1 December 2026". */
export function day(iso: string, locale: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(written(locale), { dateStyle: "long", timeZone: "UTC" }).format(d);
}
