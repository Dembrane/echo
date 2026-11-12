import { isCommonWord } from "./stoplists";

/**
 * The rules a proposed key term has to pass, applied in code after the model answers, so
 * the prompt is never the only thing between a host and a bad list. Pure functions: the
 * tests feed them many cases in every language without a model.
 *
 * Why so strict: key terms are read for every chunk at transcription time, in the final
 * transcript edit, in summaries and replies. A short precise list fixes names; a long one
 * makes the model insert a term where nobody said it. Vendor guidance is 20 to 50 terms at
 * most, proper nouns with correct capitals, no common words, short phrases.
 */

/** Most terms a project holds after accepting, the host's own ones included. */
export const MAX_KEY_TERMS = 30;
export const MAX_TERM_WORDS = 6;
export const MAX_TERM_CHARS = 60;
const MAX_REASON_CHARS = 160;

export type TermSource = "description" | "text" | "url";

/** What the host gave and what was read from the link, by where it came from. */
export type TermSources = Readonly<Partial<Record<TermSource, string>>>;

export interface ProposedTerm {
  readonly term: string;
  readonly reason: string;
  readonly source: TermSource;
}

/** Collapses every run of whitespace (including non-breaking spaces) to one space. */
export const collapse = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[\s ]+/gu, " ")
    .trim();

/** Punctuation a model or a list leaves around a term: quotes, brackets, commas, full stops. */
const LEAD = /^[\s"'“”‘’«»„()[\]{}<>,;:.!?*•·\-–]+/u;
const TRAIL = /[\s"'“”‘’«»„()[\]{}<>,;:!?*•·\-–]+$/u;
/** A closing full stop, except after a capital ("B.V.", "e.V." keep theirs). */
const TRAIL_DOT = /(?<!\p{Lu})\.+$/u;

export function tidy(term: string): string {
  let t = collapse(term);
  for (let i = 0; i < 3; i++) t = t.replace(LEAD, "").replace(TRAIL, "").replace(TRAIL_DOT, "");
  return t.trim();
}

/** Case-insensitive identity of a term: what dedupe compares. */
export const termKey = (term: string) => collapse(term).toLocaleLowerCase();

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** One place a term occurs: as the source writes it, and whether it starts a sentence. */
export interface Occurrence {
  readonly text: string;
  /** First word of a sentence, a line or a list item: its capital proves nothing. */
  readonly initial: boolean;
}

/** Whether position `at` of `soft` (newlines kept) starts a sentence, a line or an item. */
function startsSentence(soft: string, at: number): boolean {
  const lineStart = soft.lastIndexOf("\n", at - 1) + 1;
  // Only times, numbers, bullets or punctuation before it on its line: "19.30 Welkom".
  if (/^[\s\p{N}.:,;()*•·\-–]*$/u.test(soft.slice(lineStart, at))) return true;
  const before = soft.slice(lineStart, at).trimEnd();
  return /[.!?]$/.test(before);
}

/**
 * Every place `term` occurs in `haystack` as a whole word or phrase, case-insensitively,
 * with whitespace normalised (a name may wrap across lines). Returns the text as the
 * source writes it at each place, so the caller keeps the source's capitalisation.
 */
export function occurrences(term: string, haystack: string): Occurrence[] {
  const needle = termKey(term);
  if (!needle) return [];
  // Newlines survive in `soft` for the sentence check; `flat` is the same length with
  // every newline a space, which is what the term is matched against.
  const soft = haystack
    .normalize("NFC")
    .replace(/[\s ]+/gu, (run) => (/[\n\r]/.test(run) ? "\n" : " "))
    .trim();
  const flat = soft.replaceAll("\n", " ");
  const lower = flat.toLocaleLowerCase();
  // Lowercasing can change length for a few scripts; then positions no longer line up and
  // we fall back to the lowercased text, which still proves the term is there.
  const aligned = lower.length === flat.length;
  const out: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    const before = lower[at - 1] ?? "";
    const after = lower[at + needle.length] ?? "";
    if (!LETTER_OR_DIGIT.test(before) && !LETTER_OR_DIGIT.test(after))
      out.push({
        text: aligned ? flat.slice(at, at + needle.length) : needle,
        initial: aligned && startsSentence(soft, at),
      });
    from = at + 1;
  }
  return out;
}

const hasUpper = (s: string) => s !== s.toLocaleLowerCase();
/** An abbreviation: two or more capitals, maybe with digits, dots, ampersands or a dash. */
const isAcronym = (s: string) => /^(?=(?:.*\p{Lu}){2})[\p{Lu}\p{N}&.\-/]+$/u.test(s);
const words = (s: string) => s.split(" ").filter(Boolean);

/** Why a candidate is dropped, for the tests; null when it passes. */
export type DropReason =
  | "empty"
  | "too_long"
  | "too_many_words"
  | "not_in_source"
  | "common_word"
  | "lowercase_word"
  | "number"
  | "shouting"
  | "duplicate"
  | "cap";

/**
 * One candidate against the rules, given where it may come from. Returns the term as the
 * source spells it and where it was found, or why it was dropped.
 */
export function checkTerm(
  candidate: string,
  sources: TermSources,
  language: string,
): TermCheck<TermSource> {
  const ordered = (["description", "text", "url"] as const).flatMap((source) => {
    const text = sources[source];
    return text ? [{ name: source, text }] : [];
  });
  const checked = checkTermIn(candidate, ordered, language);
  return checked.ok ? { ...checked, source: checked.source as TermSource } : checked;
}

/** A source a term may come from, by its name (a file name, "pasted text", a link). */
export interface NamedSource {
  readonly name: string;
  readonly text: string;
}

/**
 * `checkTerm` against any list of named sources, in the order a host would recognise
 * them (ECHO-1055: the digest's files, pasted text and link). Returns the name of the
 * first source the term occurs in.
 */
export function checkTermIn(
  candidate: string,
  sources: readonly NamedSource[],
  language: string,
): TermCheck<string> {
  const term = tidy(candidate);
  if (term.length < 2) return { ok: false, why: "empty" };
  if (term.length > MAX_TERM_CHARS) return { ok: false, why: "too_long" };
  const parts = words(term);
  if (parts.length > MAX_TERM_WORDS) return { ok: false, why: "too_many_words" };
  if (!/\p{L}/u.test(term)) return { ok: false, why: "number" };
  // Where it occurs, in the order a host would recognise: what they typed, what they
  // pasted, then the page. The model's own claim about the source is never trusted.
  let found: { source: string } | null = null;
  const all: Occurrence[] = [];
  for (const { name, text } of sources) {
    if (!text) continue;
    const spellings = occurrences(term, text);
    if (spellings.length && !found) found = { source: name };
    all.push(...spellings);
  }
  if (!found) return { ok: false, why: "not_in_source" };
  // The source's capitalisation: a spelling in ordinary case first (a heading in capitals
  // is not how a name is written), then any spelling with a capital, then the first one.
  const ordinary = (s: string) =>
    hasUpper(s) && (words(s).length === 1 || s !== s.toLocaleUpperCase());
  const texts = all.map((o) => o.text);
  const spelled =
    all.find((o) => ordinary(o.text) && !o.initial)?.text ??
    texts.find(ordinary) ??
    texts.find(hasUpper) ??
    texts[0] ??
    term;
  const spelledParts = words(spelled);
  // Three or more words all in capitals is a heading or shouting, not a name: an
  // abbreviation is one word ("GGD", "NHS ICB" is two).
  if (
    spelledParts.length >= 3 &&
    spelled === spelled.toLocaleUpperCase() &&
    /\p{Lu}/u.test(spelled)
  )
    return { ok: false, why: "shouting" };
  if (spelledParts.every((w) => isCommonWord(w, language)))
    return { ok: false, why: "common_word" };
  if (spelledParts.length === 1) {
    // A single lowercase dictionary-like word is dropped unless the source writes it with
    // a capital or as an abbreviation somewhere. A capital that only starts a sentence or
    // an agenda line ("19.30 Inloop", "Facilitated by") proves nothing.
    const named = all.some((o) => isAcronym(o.text) || (hasUpper(o.text) && !o.initial));
    if (!named) return { ok: false, why: "lowercase_word" };
  }
  return { ok: true, term: spelled, source: found.source };
}

/** A reason as one short line. */
export function oneLine(reason: string, max = MAX_REASON_CHARS): string {
  const line = collapse(reason.replace(/\s*[\u2014\u2013]\s*/g, ", "));
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A candidate term as checked against the material: its spelling there and where, or why not. */
export type TermCheck<S> = { ok: true; term: string; source: S } | { ok: false; why: DropReason };

/**
 * The model's candidates, kept in its order (it is asked for the most important first):
 * each must pass `check`, none may repeat another or a term the project already has, and
 * together with the existing ones there are at most MAX_KEY_TERMS. `keep` makes the kept
 * entry; suggestions and the digest each add their own fields.
 */
export function keepTerms<C extends { term: string }, S, T>(
  candidates: readonly C[],
  existing: readonly string[],
  check: (c: C) => TermCheck<S>,
  keep: (c: C, checked: { term: string; source: S }) => T,
): { terms: T[]; dropped: { term: string; why: DropReason }[] } {
  const seen = new Set(existing.map(termKey).filter(Boolean));
  const room = Math.max(0, MAX_KEY_TERMS - seen.size);
  const terms: T[] = [];
  const dropped: { term: string; why: DropReason }[] = [];
  for (const c of candidates) {
    const checked = check(c);
    if (!checked.ok) {
      dropped.push({ term: c.term, why: checked.why });
      continue;
    }
    const key = termKey(checked.term);
    if (seen.has(key)) {
      dropped.push({ term: c.term, why: "duplicate" });
      continue;
    }
    if (terms.length >= room) {
      dropped.push({ term: c.term, why: "cap" });
      continue;
    }
    seen.add(key);
    terms.push(keep(c, checked));
  }
  return { terms, dropped };
}

/** The suggestions' candidates, cleaned by `keepTerms` against the host's three sources. */
export function cleanKeyTerms(
  candidates: readonly { term: string; reason: string }[],
  o: { sources: TermSources; existing: readonly string[]; language: string },
): { terms: ProposedTerm[]; dropped: { term: string; why: DropReason }[] } {
  return keepTerms(
    candidates,
    o.existing,
    (c) => checkTerm(c.term, o.sources, o.language),
    (c, checked) => ({ term: checked.term, reason: oneLine(c.reason), source: checked.source }),
  );
}

/** The host's existing key terms from the stored comma-separated value or a list. */
export function parseKeyTerms(value: string | readonly string[] | null | undefined): string[] {
  const list = typeof value === "string" ? value.split(",") : [...(value ?? [])];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const t = collapse(raw);
    const k = t.toLocaleLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
