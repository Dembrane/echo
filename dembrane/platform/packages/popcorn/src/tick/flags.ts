import { dict, isRecord, type Json, list, orStr } from "../py";
import { casefold } from "../text";
import { escapeRegExp, pyRepr, W, WB_START } from "./util";

/**
 * Deterministic checks on a fast-pass response before it reaches the room (popcorn
 * flags.py): two phrases naming one idea, a phrase carrying a name somebody introduced
 * themselves with, and a phrase quoting text the room was shown. The third needs the
 * previous state, which the tick snapshots before it writes anything.
 */

const STOP = new Set(
  "a an the and or of to in on at for is are was were be it its this that with as by from not no we you they he she i our your their his her them us me if so but than then".split(
    " ",
  ),
);
// Negation is not a stopword: "not" is the whole difference between two phrases.
const NEGATION = new Set("not no never nor none nobody nothing neither without cannot".split(" "));
export const KNOWN_RUN = 6;
const NEAR_DUPLICATE = 0.5;

// A name: a capital, then letters, any script Latin can write.
const NAME = "([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]{2,})";
const INTRO = new RegExp(
  `${WB_START}(?:I'm|I am|my name's|my name is|this is|Hi|Hey|Hello|Thanks|Thank you|Welcome),?\\s+${NAME}`,
  "giu",
);
const ADDRESSED = new RegExp(
  `${WB_START}${NAME},\\s+(?:you're|you are|would you|are you|do you|what do you|be interesting|yeah|thanks|there's|sorry)` +
    `|${WB_START}what ${NAME} (?:was|is) saying|${WB_START}Thanks,?\\s+${NAME}|${WB_START}to ${NAME}'s point`,
  "giu",
);
// Capitalised words the patterns above catch that are not names.
const NOT_NAMES = new Set(
  "Okay Yeah Yes Well Good Right Fine Great Nice Lovely Cool Brilliant Fantastic Sorry Because Just There Here What When Where Which Dembrane".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return casefold(text || "").match(/[a-z0-9']+/g) ?? [];
}

export function contentTokens(text: string): Set<string> {
  return new Set(tokens(text).filter((t) => !STOP.has(t) && [...t].length > 2));
}

/** n-word runs, each as one key. */
export function shingles(words: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join("\u0001"));
  return out;
}

const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Names people gave in introductions or were addressed by. */
export function introducedNames(transcript: string): Set<string> {
  const found = new Set<string>();
  for (const m of transcript.matchAll(INTRO)) if (m[1]) found.add(m[1]);
  for (const m of transcript.matchAll(ADDRESSED))
    for (const name of m.slice(1)) if (name) found.add(name);
  return new Set([...found].filter((n) => isUpper(n.slice(0, 1)) && !NOT_NAMES.has(n)));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Names from the introductions that appear in the text as names, written with their
 * capital; a lowercase match is a common word that happens to be somebody's name.
 */
export function nameHits(text: string, names: ReadonlySet<string>): string[] {
  const words = new Set((text || "").match(/[\p{L}\p{Nl}\p{No}]+/gu) ?? []);
  return [...names].filter((n) => words.has(n)).sort(cmp);
}

/** Anything that may reach a screen loses the names from the introductions. */
export function scrubNames(text: string, names: ReadonlySet<string>): string {
  let out = text;
  for (const n of [...names].sort((a, b) => [...b].length - [...a].length))
    out = out.replace(
      new RegExp(`${WB_START}${escapeRegExp(n)}(?:'s)?(?!${W})`, "gu"),
      "a participant",
    );
  return out;
}

export function negated(text: string): boolean {
  return tokens(text).some((t) => NEGATION.has(t) || t.endsWith("n't"));
}

export function jaccard(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}

/** The first run of `n` words the text shares with the known text, or null. */
export function knownRun(text: string, known: ReadonlySet<string>, n = KNOWN_RUN): string | null {
  if (!known.size) return null;
  for (const s of shingles(tokens(text), n)) if (known.has(s)) return s.split("\u0001").join(" ");
  return null;
}

// Keys whose values the room never sees, or that are not prose.
const NOT_SHOWN = new Set([
  "id",
  "url",
  "transcript",
  "source",
  "review",
  "fingerprint",
  "error",
  "label",
  "short",
]);

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) if (!NOT_SHOWN.has(k)) yield* strings(v);
}

/**
 * Every run of `n` words the tool itself has put in front of the room: the phrases on
 * the stage and the text of the slides. Quotes are the room's words and stay out.
 * `exclude` leaves out one conversation's own phrases.
 */
export function knownShingles(state: Json, n = KNOWN_RUN, exclude?: string): Set<string> {
  const words: string[] = [];
  for (const [cid, conv] of Object.entries(dict(state.conversations))) {
    if (cid === exclude) continue;
    for (const item of list(dict(conv).items)) {
      words.push(...tokens(orStr(dict(item).phrase)));
      words.push("\u0000"); // runs never cross from one text to the next
    }
  }
  for (const text of strings(dict(state.analysis))) {
    words.push(...tokens(text));
    words.push("\u0000");
  }
  return new Set(shingles(words, n).filter((s) => !s.includes("\u0000")));
}

/** Split a shaped response into what the room may see and what it may not. */
export function gateItems(
  items: readonly Json[],
  names: ReadonlySet<string>,
  known: ReadonlySet<string>,
): [Json[], Json[]] {
  const kept: Json[] = [];
  const suppressed: Json[] = [];
  for (const item of items) {
    const phrase = orStr(item.phrase);
    const hit = nameHits(phrase, names);
    if (hit.length) {
      suppressed.push({
        ...item,
        reason: `carries a name from the introductions (${hit.join(", ")})`,
      });
      continue;
    }
    const run = knownRun(phrase, known);
    if (run) {
      suppressed.push({
        ...item,
        reason: `shares ${KNOWN_RUN} words with text the room was shown (${pyRepr(run)})`,
      });
      continue;
    }
    const twin = kept.find(
      (k) =>
        jaccard(String(k.phrase), phrase) >= NEAR_DUPLICATE &&
        negated(String(k.phrase)) === negated(phrase),
    );
    if (twin) {
      // Of two phrases for one idea the first stays; nothing weighs them.
      suppressed.push({ ...item, reason: `says what ${pyRepr(twin.phrase)} says` });
      continue;
    }
    kept.push(item);
  }
  return [kept, suppressed];
}
