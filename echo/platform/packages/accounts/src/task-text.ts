import { type Locale, resolveLocale, translator } from "@dembrane/i18n";

/**
 * The words of the tasks echo creates, for the places the server itself writes to a
 * person: reminder emails and Slack. The API returns these tasks as a code and params and
 * the UI words them the same way in the viewer's language; here they come from the
 * server catalog (packages/i18n/locales, ids task.<code>.title and task.<code>.body).
 */

export const TASK_CODES = ["sign_offer", "billing_details", "sign_dpa"] as const;
export type TaskCode = (typeof TASK_CODES)[number];
export type TaskParams = Readonly<Record<string, string>>;

export const isTaskCode = (v: unknown): v is TaskCode =>
  typeof v === "string" && (TASK_CODES as readonly string[]).includes(v);

/** A task's title in a language: its own title, or its code worded. */
export function taskTitle(
  t: { code: string | null; params: unknown; title: string | null },
  language: Locale,
): string {
  if (!isTaskCode(t.code)) return t.title ?? "";
  const tr = translator(language);
  const params = (t.params ?? {}) as TaskParams;
  if (t.code === "sign_offer" && params.document_title)
    return tr("task.sign_offer.title_document", params);
  return tr(`task.${t.code}.title`, params);
}

export function taskBody(
  t: { code: string | null; body: string | null },
  language: Locale,
): string | null {
  return isTaskCode(t.code) ? translator(language)(`task.${t.code}.body`) : t.body;
}

/** A stored language ("nl-NL", "nl", a document's "en") as one of the product's locales. */
export const languageOf = (v: string | null | undefined): Locale => resolveLocale(v);
