import { BUILT_IN_TOPICS, NAME_LABEL_MAX, type ProjectTemplate } from "../project-templates";
import {
  type DigestAnswer,
  LISTED_TEMPLATE_KEYS,
  PROVENANCE_FIELDS,
  type ProvenanceField,
} from "./digest-model";
import { checkTermIn, collapse, keepTerms, type NamedSource, oneLine, termKey } from "./rules";

/**
 * The rules a digest answer passes in code (ECHO-1055), after the model, so the prompt is
 * never the only thing between a host's material and their project. Pure functions: the
 * tests feed them naive and adversarial answers without a model.
 *
 * - key terms: as setup suggestions (literally in a source, caps, stoplist, dedupe);
 * - the template: a listed key or nothing; runner-ups the same, never the choice itself;
 * - Verify topics: built-in keys only;
 * - tags: deduped, short, at most eight;
 * - context: hard-capped, lines with e-mail addresses or phone numbers removed, and runs of
 *   more than five personal names taken out (scrubPersonalData);
 * - provenance: a snippet must occur word for word in the source it names, or it is gone;
 * - nothing outside these fields reaches the response: the answer has no settings at all,
 *   so a source that asks for a privacy or legal setting (NEVER_PROPOSED) gets nothing, and
 *   the create request refuses anything outside its own allow-list.
 * A field with nothing left is omitted, never filled in.
 */

export const DIGEST_LIMITS = {
  name: 80,
  goal: 400,
  context: 1_500,
  tags: 8,
  tag: 40,
  verifyTopics: 3,
  explorePrompt: 600,
  hostSteps: 3,
  hostStep: 200,
  snippet: 160,
  reason: 160,
} as const;

export interface DigestProvenance {
  readonly source: string;
  readonly snippet: string;
}

export interface DigestTerm {
  readonly term: string;
  readonly reason: string;
  /** The source the term occurs in, by name. */
  readonly source: string;
  /** The line of that source it occurs in, cut to the snippet length. */
  readonly snippet: string;
}

export interface DigestResult {
  readonly name?: string;
  readonly goal?: string;
  readonly context?: string;
  readonly key_terms: DigestTerm[];
  readonly template?: { key: string; reason: string; runner_ups: string[] };
  readonly tags?: string[];
  readonly name_label?: string;
  readonly verify_topics?: string[];
  readonly explore_prompt?: string;
  readonly host_script_additions?: string[];
  readonly provenance: Partial<Record<ProvenanceField, DigestProvenance>>;
}

/** Text compared for "occurs word for word": whitespace runs, quotes and case don't count. */
const comparable = (s: string) =>
  collapse(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .toLocaleLowerCase();

/** Dashes a model writes into prose (the house style has none), made commas. */
const noDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");

/** One line of plain text, at most `max` characters, cut at a word. */
export function capLine(text: string, max: number): string {
  const line = collapse(noDashes(text));
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "");
}

/** Text with its lines kept, at most `max` characters, cut at a line or a sentence. */
export function capText(text: string, max: number): string {
  const tidy = noDashes(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (tidy.length <= max) return tidy;
  const head = tidy.slice(0, max);
  const line = head.lastIndexOf("\n");
  if (line > max * 0.6) return head.slice(0, line).trim();
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence > max * 0.6) return head.slice(0, sentence + 1).trim();
  return capLine(head, max);
}

// ── Personal data in the context ─────────────────────────────────────

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u;
/** A run that starts like a phone number: a + country code, 00, or a leading 0. */
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}])(?:\+|00|0)\(?\d[\d\s().\-/]{6,}\d(?![\p{L}\p{N}])/gu;
/** Dates and times look like numbers too: 12-11-2026, 06.11.2026, 19.30-21.00. */
const DATE_OR_TIME =
  /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b|\b\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}[.:]\d{2}\b/;

/** Whether a line holds something that reads as a phone number (9 to 15 digits). */
export function hasPhoneNumber(line: string): boolean {
  for (const m of line.matchAll(PHONE_CANDIDATE)) {
    const run = m[0];
    if (DATE_OR_TIME.test(run)) continue;
    const digits = run.replace(/\D/g, "").length;
    if (digits >= 9 && digits <= 15) return true;
  }
  return false;
}

export const hasEmail = (line: string) => EMAIL.test(line);

/** Words that may sit inside a name: van, de, der, ten, von, du, da, bin, al. */
const PARTICLE =
  /^(?:van|de|der|den|het|ter|ten|te|op|in|'t|von|zu|vom|du|da|di|del|della|des|le|la|dos|das|bin|al|el|mac|o')$/i;
/** A capitalised name word: Anna, De, O'Brien, Jan-Willem, Ünal; or an initial (J.). */
const NAME_WORD = /^(?:\p{Lu}[\p{Ll}'’-]+(?:-\p{Lu}[\p{Ll}'’]+)?|\p{Lu}\.)$/u;

/**
 * Whether a short item reads as one person's name: two to five words, the first and last
 * capitalised name words, the ones between name words or particles ("Arne van der Berg").
 * A role after a comma or in brackets is allowed and ignored ("Anna de Vries (chair)").
 */
export function looksLikePersonName(item: string): boolean {
  const core = item
    .replace(/^[\s*•·\-–\d.)]+/, "")
    .replace(/\s*[(,–:].*$/, "")
    .trim();
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  const first = words[0] as string;
  const last = words[words.length - 1] as string;
  if (!NAME_WORD.test(first) || !NAME_WORD.test(last) || last.endsWith(".")) return false;
  return words.slice(1, -1).every((w) => NAME_WORD.test(w) || PARTICLE.test(w));
}

/** More than this many names in a row is an attendee list, not a name that matters. */
export const MAX_NAMES_IN_A_ROW = 5;

export interface Scrubbed {
  readonly text: string;
  readonly removed: number;
}

/**
 * The context without the personal data it must not carry, conservatively: only what
 * clearly is a contact detail or a list of people goes.
 * - a line with an e-mail address or a phone number: a short line ("Contact: ...") goes
 *   whole; in a longer one only the sentence that holds it goes;
 * - more than five lines in a row that each read as a person's name go;
 * - in one line, a list of more than five names separated by commas or semicolons goes.
 */
export function scrubPersonalData(text: string): Scrubbed {
  let removed = 0;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!hasEmail(line) && !hasPhoneNumber(line)) {
      kept.push(line);
      continue;
    }
    const sentences = line.split(/(?<=[.!?])\s+/);
    const clean = sentences.filter((s) => !hasEmail(s) && !hasPhoneNumber(s));
    removed += 1;
    const rest = clean.join(" ").trim();
    if ((rest.match(/\p{L}/gu) ?? []).length >= 40) kept.push(rest);
  }
  // Runs of name lines.
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > MAX_NAMES_IN_A_ROW) removed += 1;
    else out.push(...run);
    run = [];
  };
  for (const line of kept) {
    if (line.trim() && looksLikePersonName(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  // Inline lists of names.
  const inline = out.map((line) => {
    const items = line
      .split(/\s*[,;:]\s*|\s+(?:and|en|und|et|y|e|a|і|и)\s+/u)
      .map((item) => item.replace(/[.!?]+$/, ""));
    let best = 0;
    let streak = 0;
    for (const item of items) {
      streak = looksLikePersonName(item) ? streak + 1 : 0;
      best = Math.max(best, streak);
    }
    if (best <= MAX_NAMES_IN_A_ROW) return line;
    removed += 1;
    return "";
  });
  const textOut = inline
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: textOut, removed };
}

// ── Provenance ───────────────────────────────────────────────────────

/** A snippet at most DIGEST_LIMITS.snippet long, cut at a word. */
const snippetOf = (s: string) => capLine(s, DIGEST_LIMITS.snippet);

/** Whether `snippet` occurs word for word in `source` (whitespace, quotes and case aside). */
export function occursIn(snippet: string, source: string): boolean {
  const needle = comparable(snippet);
  return needle.length >= 3 && comparable(source).includes(needle);
}

/** The line of a source a term occurs in, as a snippet; the term's own text when none. */
export function lineWith(term: string, source: string): string {
  const key = termKey(term);
  const line = source.split(/\n|(?<=[.!?])\s+/).find((l) => comparable(l).includes(key));
  if (!line) return snippetOf(term);
  const flat = collapse(line);
  if (flat.length <= DIGEST_LIMITS.snippet) return flat;
  // Centre the snippet on the term.
  const at = flat.toLocaleLowerCase().indexOf(key);
  const start = Math.max(0, Math.min(at - 50, flat.length - DIGEST_LIMITS.snippet));
  const from = start > 0 ? flat.indexOf(" ", start) + 1 || start : 0;
  return snippetOf(flat.slice(from));
}

/**
 * Provenance the model gave, kept only where the snippet occurs in the named source. A
 * snippet over the limit is cut at a word first; a cut prefix of a true snippet is true.
 */
export function cleanProvenance(
  raw: DigestAnswer["provenance"],
  sources: readonly NamedSource[],
): Partial<Record<ProvenanceField, DigestProvenance>> {
  const out: Partial<Record<ProvenanceField, DigestProvenance>> = {};
  for (const p of raw) {
    if (!(PROVENANCE_FIELDS as readonly string[]).includes(p.field)) continue;
    const field = p.field as ProvenanceField;
    if (out[field]) continue;
    const source = sources.find((s) => s.name === p.source);
    if (!source) continue;
    const snippet = snippetOf(p.snippet.replace(/^[\s"'“”…]+|[\s"'“”…]+$/g, ""));
    if (!occursIn(snippet, source.text)) continue;
    out[field] = { source: source.name, snippet };
  }
  return out;
}

// ── Grounding ────────────────────────────────────────────────────────

/** The words of a text worth checking: letters, at least three of them. */
const wordsOf = (s: string) => comparable(s).match(/[\p{L}][\p{L}'-]{2,}/gu) ?? [];

/**
 * How many of a short text's words occur in the material. Names, tags and the name box
 * label are asked for in the material's own words: one that shares nothing with it was
 * made up (or obeys an injection), and is dropped.
 */
export function groundedWords(text: string, material: string): { found: number; total: number } {
  const words = wordsOf(text);
  return { found: words.filter((w) => material.includes(w)).length, total: words.length };
}

/** Three or more words all in capitals: a heading or shouting, never a project name. */
const shouting = (s: string) => {
  const words = s.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return words.length >= 3 && s === s.toLocaleUpperCase() && /\p{Lu}/u.test(s);
};

// ── The whole answer ─────────────────────────────────────────────────

export interface CleanInput {
  readonly answer: DigestAnswer;
  /** The original sources, by name: what terms and snippets must occur in. */
  readonly sources: readonly NamedSource[];
  readonly existingTerms: readonly string[];
  readonly language: string;
  /** Resolves a listed key to its template; the caller's registry. */
  readonly templateOf: (key: string) => ProjectTemplate | null;
}

const dedupe = (items: readonly string[], max: number, each: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = capLine(raw, each);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
};

export function cleanDigest(i: CleanInput): DigestResult & { personal_data_removed: number } {
  const a = i.answer;
  const listed = (k: string) => (LISTED_TEMPLATE_KEYS as readonly string[]).includes(k);

  // Key terms: the suggestions' rules against every source, then a snippet from its line.
  const { terms } = keepTerms(
    a.key_terms,
    i.existingTerms,
    (c) => checkTermIn(c.term, i.sources, i.language),
    (c, checked): DigestTerm => ({
      term: checked.term,
      reason: oneLine(c.reason, DIGEST_LIMITS.reason),
      source: checked.source,
      snippet: lineWith(checked.term, i.sources.find((s) => s.name === checked.source)?.text ?? ""),
    }),
  );

  const templateKey = listed(a.template_key) ? a.template_key : null;
  const template = templateKey ? i.templateOf(templateKey) : null;
  const runnerUps = [...new Set(a.runner_up_keys)]
    .filter((k) => listed(k) && k !== templateKey)
    .slice(0, 2);

  const material = comparable(i.sources.map((s) => s.text).join("\n"));
  const rooted = (text: string, minWords: number, minLetters = 3) => {
    const g = groundedWords(text, material);
    const long = wordsOf(text).filter((w) => w.length >= minLetters && material.includes(w));
    return g.found >= Math.min(minWords, g.total) && long.length > 0;
  };
  const named = capLine(a.name, DIGEST_LIMITS.name);
  // A name shares at least one real word with the material (it may be translated around it).
  const name = named && !shouting(named) && rooted(named, 1, 4) ? named : "";
  const goal = capText(a.goal, DIGEST_LIMITS.goal).replace(/\n+/g, " ");
  const scrubbed = scrubPersonalData(capText(a.context, DIGEST_LIMITS.context * 2));
  const context = capText(scrubbed.text, DIGEST_LIMITS.context);
  const tags = dedupe(
    a.tags.filter((t) => rooted(t, 1)),
    DIGEST_LIMITS.tags,
    DIGEST_LIMITS.tag,
  );
  // A name box label only where the template asks for a name, and short.
  const asksName = template?.preset.fields.default_conversation_ask_for_participant_name ?? true;
  const labelled = capLine(a.name_label, Math.min(40, NAME_LABEL_MAX));
  // At most three words, each one in the material ("Tafel" from "tafels").
  const label =
    asksName &&
    labelled &&
    labelled.split(" ").length <= 3 &&
    groundedWords(labelled, material).found === wordsOf(labelled).length &&
    wordsOf(labelled).length > 0
      ? labelled
      : "";
  const topics = [
    ...new Set(a.verify_topics.filter((t) => (BUILT_IN_TOPICS as readonly string[]).includes(t))),
  ].slice(0, DIGEST_LIMITS.verifyTopics);
  // An Explore prompt is an instruction the reply model reads: no links or addresses in it.
  const explore = capText(a.explore_prompt, DIGEST_LIMITS.explorePrompt);
  const exploreOk = explore && !/https?:\/\/|www\.|@/i.test(explore) ? explore : "";
  // A step is a sentence a table host can follow, not a word.
  const steps = dedupe(
    a.host_script_additions.filter((x) => collapse(x).length >= 12),
    DIGEST_LIMITS.hostSteps,
    DIGEST_LIMITS.hostStep,
  );

  const provenance = cleanProvenance(a.provenance, i.sources);
  const result = {
    ...(name && { name }),
    ...(goal && { goal }),
    ...(context && { context }),
    key_terms: terms,
    ...(templateKey && {
      template: {
        key: templateKey,
        reason: oneLine(a.template_reason, DIGEST_LIMITS.reason),
        runner_ups: runnerUps,
      },
    }),
    ...(tags.length && { tags }),
    ...(label && { name_label: label }),
    ...(topics.length && { verify_topics: topics }),
    ...(exploreOk && { explore_prompt: exploreOk }),
    ...(steps.length && { host_script_additions: steps }),
    personal_data_removed: scrubbed.removed,
  };
  // Provenance only for fields that survived.
  const present = (f: ProvenanceField) =>
    f === "template_key"
      ? Boolean(templateKey)
      : (result as Record<string, unknown>)[f] !== undefined;
  return {
    ...result,
    provenance: Object.fromEntries(
      Object.entries(provenance).filter(([f]) => present(f as ProvenanceField)),
    ) as DigestResult["provenance"],
  };
}

/** How many of the answer's fields have content: zero means nothing useful came back. */
export function fieldsReturned(r: DigestResult): string[] {
  const f: string[] = [];
  if (r.name) f.push("name");
  if (r.goal) f.push("goal");
  if (r.context) f.push("context");
  if (r.key_terms.length) f.push("key_terms");
  if (r.template) f.push("template");
  if (r.tags) f.push("tags");
  if (r.name_label) f.push("name_label");
  if (r.verify_topics) f.push("verify_topics");
  if (r.explore_prompt) f.push("explore_prompt");
  if (r.host_script_additions) f.push("host_script_additions");
  return f;
}
