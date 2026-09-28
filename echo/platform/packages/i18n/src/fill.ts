import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Completer, LANGUAGE_NAMES, translateTexts } from "@dembrane/llm";
import glossaryFile from "../glossary.json";
import { fillEntry, missingEntries, type PoEntry, parsePo, serializePo } from "./po";

/**
 * Fills the translations a catalog still owes with the model, the way the analysis
 * features translate (translateTexts in @dembrane/llm), and flags each one fuzzy for a
 * person to review. Only empty entries are filled: a translation someone wrote or
 * reviewed, or an earlier machine one still waiting for review, is never replaced.
 */

export const SOURCE_LOCALE = "en-US";

const SYSTEM = `You translate the interface texts of dembrane, a product for facilitated group conversations: hosts run projects, participants speak through a portal on their phone, and dembrane turns what was said into transcripts, reports and insights.

The user message is JSON: a target language, a glossary, and a numbered list of texts, each with an optional note saying where it appears (an error code, a screen). Return JSON of the form {"translations": [{"i": 0, "text": "..."}]} with exactly one entry per input text and the same i.

How to translate:
- Plain, short and friendly, the way a good product writer in that language would say it. Keep the length close to the original.
- Keep every placeholder exactly as written: {name}, {0}, and ICU structures such as {count, plural, one {...} other {...}}, where only the words inside the branches are translated. Keep numbered tags such as <0>...</0> around the matching words.
- Use the glossary's terms and register. Keep the words in "keep" as they are. "dembrane" is always lowercase.
- Keep leading and trailing spaces and punctuation as in the original.
- Never leave a text out, never merge texts, never add explanations.`;

interface Glossary {
  readonly keep: readonly string[];
  readonly notes: readonly string[];
  readonly languages: Readonly<
    Record<string, { readonly register: string; readonly terms: Readonly<Record<string, string>> }>
  >;
}
const glossary = glossaryFile as Glossary;

/** The placeholders and tags a translation must keep: {name} openers and <0> tags. */
export function placeholdersOf(text: string): string {
  const names = [...text.matchAll(/\{\s*([A-Za-z0-9_]+)/g)].map((m) => `{${m[1]}`);
  const tags = [...text.matchAll(/<\/?\d+\s*\/?>/g)].map((m) => m[0].replace(/\s/g, ""));
  return [...names, ...tags].sort().join(" ");
}

const keyOf = (e: Pick<PoEntry, "msgid" | "msgctxt">) => `${e.msgctxt ?? ""}\u0004${e.msgid}`;

/** The language code the platform names prompts by: "nl-NL" reads as "nl". */
export const languageOf = (locale: string) => locale.split("-")[0]?.toLowerCase() ?? locale;

export interface CatalogReport {
  readonly file: string;
  readonly locale: string;
  readonly missing: number;
  readonly filled: number;
  /** Answers dropped because they lost or invented a placeholder. */
  readonly rejected: number;
}

/** The locale files of one catalog directory, source first. */
export function catalogFiles(dir: string): { locale: string; file: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".po"))
    .map((f) => ({ locale: f.slice(0, -3), file: path.join(dir, f) }))
    .sort((a, b) => (a.locale === SOURCE_LOCALE ? -1 : b.locale === SOURCE_LOCALE ? 1 : 0));
}

function sourceTexts(dir: string): Map<string, string> {
  const source = parsePo(readFileSync(path.join(dir, `${SOURCE_LOCALE}.po`), "utf8"));
  const out = new Map<string, string>();
  for (const e of source.entries) {
    if (e.obsolete || !e.msgid) continue;
    const text = e.explicitId ? e.msgstr : e.msgstr || e.msgid;
    if (text) out.set(keyOf(e), text);
  }
  return out;
}

function noteFor(e: PoEntry): string | undefined {
  const parts: string[] = [];
  if (e.explicitId) parts.push(`id ${e.msgid}`);
  const comments = e.extracted.filter((c) => c !== "js-lingui-explicit-id");
  if (comments.length) parts.push(comments.join(" "));
  if (e.origins[0]) parts.push(`in ${e.origins[0].replace(/:\d+$/, "")}`);
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Counts, and with a completer fills, what each locale of `dir` owes. Returns one report
 * per locale file; writes the files it changed.
 */
export async function fillCatalog(
  dir: string,
  completer: Completer | null,
  log: (line: string) => void = () => {},
): Promise<CatalogReport[]> {
  const sources = sourceTexts(dir);
  const reports: CatalogReport[] = [];
  for (const { locale, file } of catalogFiles(dir)) {
    if (locale === SOURCE_LOCALE) continue;
    const po = parsePo(readFileSync(file, "utf8"));
    const owed = missingEntries(po).filter((e) => sources.has(keyOf(e)));
    const lang = languageOf(locale);
    const target = LANGUAGE_NAMES[lang];
    if (!completer || !owed.length || !target) {
      reports.push({ file, locale, missing: owed.length, filled: 0, rejected: 0 });
      continue;
    }
    const texts = owed.map((e) => sources.get(keyOf(e)) as string);
    const answers = await translateTexts(completer, texts, {
      system: SYSTEM,
      target,
      group: "text_fast",
      extra: {
        glossary: {
          keep: glossary.keep,
          notes: glossary.notes,
          ...(glossary.languages[lang] ?? {}),
        },
      },
      notes: owed.map(noteFor),
      warn: (m) => log(`  ${locale}: a batch failed (${m}); its entries stay empty`),
    });
    let filled = 0;
    let rejected = 0;
    owed.forEach((entry, i) => {
      const answer = answers[i];
      if (!answer) return;
      if (placeholdersOf(answer) !== placeholdersOf(texts[i] as string)) {
        rejected++;
        return;
      }
      fillEntry(entry, answer);
      filled++;
    });
    if (filled) writeFileSync(file, serializePo(po));
    reports.push({ file, locale, missing: owed.length, filled, rejected });
  }
  return reports;
}
