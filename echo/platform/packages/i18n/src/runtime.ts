import { readFileSync } from "node:fs";
import { assetPath } from "@dembrane/core";
import { parsePo } from "./po";

/**
 * The texts the server writes to people itself (emails, task titles), by id, in the
 * recipient's language. The catalogs are packages/i18n/locales/{locale}.po, lingui-style:
 * en-US holds the source text, the other locales translations, filled by the catalog
 * translator (src/cli.ts) and flagged fuzzy until a person reviews them. A missing
 * translation falls back to English, so a new text never blocks a send.
 */

/** The languages the product speaks, the same eight the frontend ships. */
export const LOCALES = [
  "en-US",
  "nl-NL",
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "uk-UA",
  "cs-CZ",
] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en-US";

/** The catalog files, for the apps' boot asset checks and their Dockerfiles. */
export const I18N_ASSETS: readonly string[] = LOCALES.map((l) => `i18n/locales/${l}.po`);

/**
 * One of the eight locales for a stored language value: "nl", "nl-NL", "NL_nl", "Dutch"
 * spellings the tables hold. Anything unknown or empty is English.
 */
export function resolveLocale(value: string | null | undefined): Locale {
  const v = (value ?? "").trim().replace("_", "-").toLowerCase();
  if (!v) return DEFAULT_LOCALE;
  const exact = LOCALES.find((l) => l.toLowerCase() === v);
  if (exact) return exact;
  const lang = v.split("-")[0];
  return LOCALES.find((l) => l.slice(0, 2).toLowerCase() === lang) ?? DEFAULT_LOCALE;
}

/** A catalog's live, translated entries by id. */
export function catalogEntries(poText: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const e of parsePo(poText).entries)
    if (!e.obsolete && e.msgid && e.msgstr) out.set(e.msgid, e.msgstr);
  return out;
}

/** Where catalogs come from: the shipped files, or text a test hands in. */
export type CatalogSource = (locale: Locale) => string;

const shipped: CatalogSource = (locale) =>
  readFileSync(assetPath("i18n", "locales", `${locale}.po`), "utf8");

/**
 * A message lookup over one catalog source, each locale read once. `message` and
 * `translator` below use the shipped catalogs.
 */
export function createMessages(source: CatalogSource = shipped) {
  const tables = new Map<Locale, ReadonlyMap<string, string>>();
  const table = (locale: Locale) => {
    let t = tables.get(locale);
    if (!t) {
      t = catalogEntries(source(locale));
      tables.set(locale, t);
    }
    return t;
  };
  return (locale: Locale, id: string, params?: MessageParams): string => {
    const text = table(locale).get(id) ?? table(DEFAULT_LOCALE).get(id);
    if (text === undefined) throw new Error(`no server message "${id}" in ${DEFAULT_LOCALE}.po`);
    return fill(text, params);
  };
}

const shippedMessages = createMessages();

export type MessageParams = Readonly<Record<string, string | number>>;

/** Fills `{name}` placeholders; a missing param keeps its placeholder so the gap shows. */
export function fill(template: string, params: MessageParams = {}): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** The text for `id` in `locale`, or in English when not translated yet. */
export function message(locale: Locale, id: string, params?: MessageParams): string {
  return shippedMessages(locale, id, params);
}

export type Translate = (id: string, params?: MessageParams) => string;

/** `message` bound to one locale; accepts any stored language value. */
export function translator(locale: string | null | undefined): Translate {
  const l = resolveLocale(locale);
  return (id, params) => message(l, id, params);
}
