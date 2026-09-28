import { type Json, orStr, pyRound } from "../py";
import { norm } from "../text";

/**
 * Deterministic grounding for popcorn phrases (popcorn grounding.py): is the phrase
 * verbatim in its transcript, and if not, which passage did it most likely come from.
 * The passage is the host's reading aid, never a citation, so the room never sees it.
 */

// The upstream review page's stopwords, so hosts see the matches the facilitator saw.
const STOP = new Set(
  (
    "a an the and or but of to in on for with at by from as is are was were be been being it " +
    "its this that these those we you they he she i not no do does did can could should would " +
    "will shall may might must have has had there their them our your his her about into over " +
    "under more most than then so if when while what which who whom whose how why all any each " +
    "few other some such only own same too very s t just don now"
  ).split(" "),
);
const WORD = /[a-zà-ÿ0-9']+/g;
const PASSAGE_MAX_CHARS = 400;
const MIN_MATCHED = 2;
const MIN_SCORE = 0.5;

const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "");

export function groundTokens(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? [])
    .filter((w) => [...w].length > 1 && !STOP.has(w))
    .map(stem);
}

export function paragraphs(transcript: string): string[] {
  return transcript
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function isVerbatim(phrase: string, transcript: string): boolean {
  const key = norm(phrase);
  return Boolean(key) && norm(transcript).includes(key);
}

/** The paragraph sharing the rarest words with the phrase, or null below the thresholds. */
export function closestPassage(phrase: string, transcript: string): Json | null {
  const words = new Set(groundTokens(phrase));
  if (!words.size) return null;
  const paras = paragraphs(transcript);
  if (!paras.length) return null;
  const sets = paras.map((p) => new Set(groundTokens(p)));
  const df = new Map<string, number>();
  for (const w of words) df.set(w, sets.filter((s) => s.has(w)).length || 1);
  let best: [number, number, number] | null = null;
  sets.forEach((s, i) => {
    let score = 0;
    let matched = 0;
    for (const w of words)
      if (s.has(w)) {
        score += 1 / (df.get(w) as number);
        matched++;
      }
    if (matched < MIN_MATCHED || score < MIN_SCORE) return;
    if (best === null || score > best[0]) best = [score, matched, i];
  });
  if (best === null) return null;
  const [score, matched, index] = best as [number, number, number];
  let text = paras[index] as string;
  const cps = [...text];
  if (cps.length > PASSAGE_MAX_CHARS)
    text = `${cps
      .slice(0, PASSAGE_MAX_CHARS - 1)
      .join("")
      .replace(/\s+$/u, "")}…`;
  return { text, score: pyRound(score, 3), matched };
}

/** Annotate extractor output in place: `verbatim` and `source` per item. */
export function groundItems(items: Json[], transcript: string): Json[] {
  for (const item of items) {
    const phrase = orStr(item.phrase);
    item.verbatim = isVerbatim(phrase, transcript);
    item.source = closestPassage(phrase, transcript);
  }
  return items;
}
