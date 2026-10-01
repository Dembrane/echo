import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Completer, LANGUAGE_NAMES, translateTexts } from "@dembrane/llm";
import glossaryFile from "../glossary.json";
import { LEDGER_FILE, pruneLedger, readLedger, writeLedger } from "./ledger";
import { fillEntry, missingEntries, type PoEntry, parsePo, serializePo } from "./po";

/**
 * Fills the translations a catalog still owes with the model, the way the analysis
 * features translate (translateTexts in @dembrane/llm), and records each one in the
 * catalog's review ledger (./ledger.ts). Only empty entries are filled: a translation someone wrote or
 * reviewed, or an earlier machine one still waiting for review, is never replaced.
 */

export const SOURCE_LOCALE = "en-US";

/** Product copy never uses the em dash; an answer that adds one is asked for again. */
const EM_DASH = String.fromCharCode(0x2014);

const SYSTEM = `You translate the interface texts of dembrane, a product for facilitated group conversations: hosts run projects, participants speak through a portal on their phone, and dembrane turns what was said into transcripts, reports and insights.

The user message is JSON: a target language, a glossary, and a numbered list of texts, each with an optional note saying where it appears (an error code, a screen). Return JSON of the form {"translations": [{"i": 0, "text": "..."}]} with exactly one entry per input text and the same i.

How to translate:
- Plain, short and friendly, the way a good product writer in that language would say it. Keep the length close to the original.
- Keep every placeholder exactly as written: {name}, {0}, and ICU structures such as {count, plural, one {...} other {...}}, where only the words inside the branches are translated. Keep numbered tags such as <0>...</0> around the matching words.
- Use the glossary's terms and register. Keep the words in "keep" as they are. "dembrane" is always lowercase.
- Keep leading and trailing spaces and punctuation as in the original.
- Never use an em dash; where the language would, use a colon, a comma or a new sentence.
- Never leave a text out, never merge texts, never add explanations.`;

interface Glossary {
  readonly keep: readonly string[];
  readonly notes: readonly string[];
  readonly languages: Readonly<
    Record<string, { readonly register: string; readonly terms: Readonly<Record<string, string>> }>
  >;
}
const glossary = glossaryFile as Glossary;

/** The text between the brace at `open` and its match, and the index after the match. */
function braced(text: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [text.slice(open + 1, i), i + 1];
  }
  return [text.slice(open + 1), text.length];
}

/** ICU argument names in `text`, walking into plural and select branches. */
function argumentNames(text: string, out: string[]): void {
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const [inner, next] = braced(text, i);
    i = next;
    const simple = inner.match(/^\s*([A-Za-z0-9_]+)\s*$/);
    if (simple) {
      out.push(simple[1] as string);
      continue;
    }
    const arg = inner.match(/^\s*([A-Za-z0-9_]+)\s*,\s*(\w+)\s*(?:,([\s\S]*))?$/);
    if (!arg) continue;
    out.push(arg[1] as string);
    if (!["plural", "select", "selectordinal"].includes(arg[2] as string) || !arg[3]) continue;
    // Branches: `key {body}` pairs; each body is text again.
    const branches = arg[3];
    for (let j = 0; j < branches.length; ) {
      if (branches[j] !== "{") {
        j++;
        continue;
      }
      const [body, after] = braced(branches, j);
      argumentNames(body, out);
      j = after;
    }
  }
}

/**
 * The placeholders and tags a translation must keep: ICU argument names (walking into
 * plural and select branches, whose words are translated freely) and <0> tags.
 */
export function placeholdersOf(text: string): string {
  const names: string[] = [];
  argumentNames(text, names);
  const tags = [...text.matchAll(/<\/?\d+\s*\/?>/g)].map((m) => m[0].replace(/\s/g, ""));
  return [...new Set(names.map((n) => `{${n}`)), ...tags].sort().join(" ");
}

export const keyOf = (e: Pick<PoEntry, "msgid" | "msgctxt">) =>
  e.msgctxt ? `${e.msgctxt}\u0004${e.msgid}` : e.msgid;

/** The language code the platform names prompts by: "nl-NL" reads as "nl". */
export const languageOf = (locale: string) => locale.split("-")[0]?.toLowerCase() ?? locale;

export interface CatalogReport {
  readonly file: string;
  readonly locale: string;
  readonly missing: number;
  readonly filled: number;
  /** Answers dropped because they lost or invented a placeholder, or added an em dash. */
  readonly rejected: number;
  /** Machine translations in this locale still waiting for a person. */
  readonly unreviewed: number;
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
  const ledger = readLedger(dir);
  const reports: CatalogReport[] = [];
  for (const { locale, file } of catalogFiles(dir)) {
    if (locale === SOURCE_LOCALE) continue;
    const po = parsePo(readFileSync(file, "utf8"));
    const current = new Map(po.entries.filter((e) => e.msgstr).map((e) => [keyOf(e), e.msgstr]));
    const waiting = pruneLedger(ledger, locale, current);
    const owed = missingEntries(po).filter((e) => sources.has(keyOf(e)));
    const lang = languageOf(locale);
    const target = LANGUAGE_NAMES[lang];
    if (!completer || !owed.length || !target) {
      reports.push({
        file,
        locale,
        missing: owed.length,
        filled: 0,
        rejected: 0,
        unreviewed: waiting,
      });
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
      const source = texts[i] as string;
      const dashAdded = answer.includes(EM_DASH) && !source.includes(EM_DASH);
      if (dashAdded || placeholdersOf(answer) !== placeholdersOf(source)) {
        rejected++;
        return;
      }
      fillEntry(entry, answer);
      const waitingHere = ledger[locale] ?? {};
      waitingHere[keyOf(entry)] = answer;
      ledger[locale] = waitingHere;
      filled++;
    });
    if (filled) writeFileSync(file, serializePo(po));
    reports.push({
      file,
      locale,
      missing: owed.length,
      filled,
      rejected,
      unreviewed: Object.keys(ledger[locale] ?? {}).length,
    });
  }
  // Written when there is something to record, or when reviews shrank an existing ledger.
  if (
    Object.values(ledger).some((l) => Object.keys(l).length) ||
    existsSync(path.join(dir, LEDGER_FILE))
  )
    writeLedger(dir, ledger);
  return reports;
}
