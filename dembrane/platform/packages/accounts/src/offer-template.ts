import { NotFoundError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { and, eq } from "drizzle-orm";
import { type AccountsDeps, type Conn, isUuid } from "./deps";
import {
  DEFAULT_TEXT,
  type Language,
  type OfferTemplate,
  type OfferTemplateText,
  type OfferText,
} from "./offer";

/**
 * Offer templates as data: the words each template gives a new draft, changed by staff or
 * sam through the API instead of a release. A row overrides the built-in words; deleting it
 * goes back to them. Which legal documents a template brings stays in code (legalKinds).
 */

const { offer_template: row } = schema;

const TEMPLATES = ["subscription", "event", "custom"] as const satisfies readonly OfferTemplate[];
const LANGUAGES = ["en", "nl"] as const satisfies readonly Language[];

export interface OfferTemplateView extends OfferTemplateText {
  readonly template: OfferTemplate;
  readonly language: Language;
  readonly changed: boolean;
  readonly updated_at: string | null;
}

type Row = typeof row.$inferSelect;

/** Some of an object's fields, as a request gives them: a field left out may be undefined. */
export type Change<T> = { [K in keyof T]?: T[K] | undefined };

/** The fields a change gives, without the ones it left undefined. */
const defined = <T extends object>(change: Change<T>): Partial<T> =>
  Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as Partial<T>;

function view(template: OfferTemplate, language: Language, r: Row | undefined): OfferTemplateView {
  const words: OfferTemplateText = r
    ? {
        kind: r.kind,
        greeting: r.greeting,
        intro: r.intro,
        closing: r.closing,
        columns: r.columns,
        valid_days: r.validDays,
      }
    : DEFAULT_TEXT[template][language];
  return {
    template,
    language,
    ...words,
    changed: Boolean(r),
    updated_at: r ? r.updatedAt.toISOString() : null,
  };
}

const isTemplate = (s: string): s is OfferTemplate => (TEMPLATES as readonly string[]).includes(s);
const isLanguage = (s: string): s is Language => (LANGUAGES as readonly string[]).includes(s);

function parsePath(template: string, language: string) {
  if (!isTemplate(template) || !isLanguage(language))
    throw new NotFoundError("offer.template_not_found");
  return { template, language };
}

async function read(c: Conn, template: OfferTemplate, language: Language) {
  const [r] = await c
    .select()
    .from(row)
    .where(and(eq(row.template, template), eq(row.language, language)))
    .limit(1);
  return view(template, language, r);
}

/** The words a new draft of this template takes. */
export async function templateText(
  c: Conn,
  template: OfferTemplate,
  language: Language,
): Promise<OfferTemplateText> {
  const {
    template: _t,
    language: _l,
    changed: _c,
    updated_at: _u,
    ...words
  } = await read(c, template, language);
  return words;
}

export async function listOfferTemplates(d: AccountsDeps) {
  const rows = await d.db.select().from(row);
  const of = (t: OfferTemplate, l: Language) =>
    rows.find((r) => r.template === t && r.language === l);
  return {
    templates: TEMPLATES.flatMap((t) => LANGUAGES.map((l) => view(t, l, of(t, l)))),
  };
}

/** Changes the words given and keeps the rest; new drafts take them, existing ones do not. */
export async function changeOfferTemplate(
  d: AccountsDeps,
  who: Signed,
  templatePath: string,
  languagePath: string,
  change: Change<OfferTemplateText>,
): Promise<OfferTemplateView> {
  const { template, language } = parsePath(templatePath, languagePath);
  const {
    template: _t,
    language: _l,
    changed: _c,
    updated_at: _u,
    ...now
  } = await read(d.db, template, language);
  const next = { ...now, ...defined(change) };
  const values = {
    template,
    language,
    kind: next.kind,
    greeting: next.greeting,
    intro: next.intro,
    closing: next.closing,
    columns: [...next.columns] as [string, string, string, string],
    validDays: next.valid_days,
    updatedAt: d.now(),
    updatedBy: isUuid(who.directusUserId) ? who.directusUserId : null,
  };
  await d.db
    .insert(row)
    .values(values)
    .onConflictDoUpdate({ target: [row.template, row.language], set: values });
  return read(d.db, template, language);
}

/** Back to the built-in words. */
export async function resetOfferTemplate(
  d: AccountsDeps,
  templatePath: string,
  languagePath: string,
): Promise<OfferTemplateView> {
  const { template, language } = parsePath(templatePath, languagePath);
  await d.db.delete(row).where(and(eq(row.template, template), eq(row.language, language)));
  return view(template, language, undefined);
}

/**
 * A draft's words: the template's, then what this draft changed before (unless the template
 * changed or the change is null), then this change.
 */
export function draftText(
  template: OfferTemplateText,
  before: OfferText | undefined,
  change: Change<OfferText> | null | undefined,
): OfferText {
  const { valid_days: _v, ...base } = template;
  const kept = change === null ? {} : (before ?? {});
  return { ...base, ...kept, ...defined(change ?? {}) };
}
