import { createHash } from "node:crypto";
import { dict, isRecord, type Json, list, orStr } from "./py";
import { targetLanguages } from "./settings";

/**
 * Results in another language, on the host's request. The tick translates every text the
 * room's bundle shows and keeps each translation under a key of its source text; the
 * bundle swaps the texts as its last step. Extra languages are for the phrases alone.
 */

export const TRANSLATION_POLICY_VERSION = "popcorn-room-v2";

const TENSION_FIELDS = ["poleA", "poleB", "knot", "narrative", "toResolve"];
const STAKEHOLDER_FIELDS = ["name", "role", "stake"];
const RELATION_FIELDS = ["label", "detail"];

const sha20 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 20);

export function textKey(text: string): string {
  return sha20(text);
}

/** A reusable translation key whose policy can change without stale reuse. */
export function cacheKey(
  text: string,
  target: string,
  policy = TRANSLATION_POLICY_VERSION,
): string {
  return sha20(`${policy}\x1f${target}\x1f${text}`);
}

type Fn = (text: string) => string;

function swap(entry: unknown, fields: readonly string[], fn: Fn): unknown {
  if (!isRecord(entry)) return entry;
  const out: Json = { ...entry };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === "string" && v.trim()) out[field] = fn(v);
  }
  return out;
}

export function mapFiles(files: Json, fn: Fn): Json {
  const out: Json = { ...files };
  for (const [name, file] of Object.entries(files)) {
    if (!isRecord(file)) continue;
    if (name.startsWith("popcorn/")) {
      out[name] = { ...file, items: list(file.items).map((i) => swap(i, ["phrase"], fn)) };
    } else if (name === "quotes.json") {
      out[name] = { ...file, quotes: list(file.quotes).map((q) => swap(q, ["text"], fn)) };
    } else if (name === "tensions.json") {
      out[name] = {
        ...file,
        tensions: list(file.tensions).map((t) => swap(t, TENSION_FIELDS, fn)),
      };
    } else if (name === "stakeholders.json") {
      const people = list(file.stakeholders).map((raw) => {
        const person = swap(raw, STAKEHOLDER_FIELDS, fn);
        if (isRecord(person) && isRecord(person.evidence))
          person.evidence = swap(person.evidence, ["note"], fn);
        return person;
      });
      const relations = list(file.relations).map((raw) => {
        const relation = swap(raw, RELATION_FIELDS, fn);
        if (isRecord(relation))
          relation.aspects = list(relation.aspects).map((a) => swap(a, ["note"], fn));
        return relation;
      });
      out[name] = { ...file, stakeholders: people, relations };
    }
  }
  return out;
}

/** Every distinct text the room's deck shows, in first-seen order. */
export function translatableTexts(files: Json): string[] {
  const seen = new Set<string>();
  mapFiles(files, (text) => {
    seen.add(text);
    return text;
  });
  return [...seen];
}

/** Every distinct phrase on the deck: what an extra language translates. */
export function popcornTexts(files: Json): string[] {
  return translatableTexts(
    Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("popcorn/"))),
  );
}

/** What `table` still owes, over the whole deck or over `texts` alone. */
export function missingTexts(
  files: Json,
  table: Json,
  target = "",
  texts: string[] | null = null,
): string[] {
  const key = target ? (t: string) => cacheKey(t, target) : textKey;
  const wanted = texts ?? translatableTexts(files);
  return wanted.filter((t) => !(key(t) in table));
}

/**
 * `bundle` in the host's chosen language, as far as the tick has got. A text not
 * translated yet shows in its original; the session says how many are on their way.
 */
export function translatedBundle(bundle: Json, state: Json, settings: Json): Json {
  const targets = targetLanguages(settings);
  const files = bundle.files;
  if (!targets.length || !isRecord(files)) return bundle;
  const target = targets[0] as string;
  const translations = dict(state.translations);
  const tables: Record<string, Json> = Object.fromEntries(
    targets.map((code) => [code, dict(translations[code])]),
  );
  const table = tables[target] as Json;
  const translated = mapFiles(files, (text) => {
    const found = table[cacheKey(text, target)];
    return typeof found === "string" ? found : text;
  });
  for (const [name, file] of Object.entries(files)) {
    if (!name.startsWith("popcorn/") || !isRecord(file)) continue;
    const items = list(file.items).map((item) => {
      if (!isRecord(item)) return item;
      const source = item.phrase;
      const stack: Json[] = [];
      if (typeof source === "string")
        for (const code of targets) {
          const found: unknown = (tables[code] as Json)[cacheKey(source, code)];
          if (typeof found === "string" && found && found !== source)
            stack.push({ language: code, text: found });
        }
      const answer = stack[0] && stack[0].language === target ? (stack[0].text as string) : null;
      const out: Json = { ...item };
      if (stack.length) out.translations = stack;
      if (answer && answer !== source) {
        out.translation = answer;
        out.translation_language = target;
        out.translation_policy = TRANSLATION_POLICY_VERSION;
        out.translation_ref = {
          source_key: textKey(String(source)),
          item_id: orStr(item.id),
          revision: file.revision ?? null,
        };
      }
      return out;
    });
    translated[name] = { ...file, items };
  }
  const session = translated["session.json"];
  if (isRecord(session)) {
    const phrases = popcornTexts(files);
    let pending = missingTexts(files, table, target).length;
    for (const code of targets.slice(1))
      pending += missingTexts(files, tables[code] as Json, code, phrases).length;
    translated["session.json"] = {
      ...session,
      translation: {
        to: target,
        also: targets.slice(1),
        policy: TRANSLATION_POLICY_VERSION,
        pending,
      },
    };
  }
  return { ...bundle, files: translated };
}
