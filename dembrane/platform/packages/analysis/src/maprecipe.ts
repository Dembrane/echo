import { sortedStrings } from "./registry";
import { casefold, normalizeText, normKey, pyStrip, pyStripChars, sha256Hex } from "./text";

/**
 * Map's recipe, the pure half: transcript windows, quote grounding, candidates, claim
 * keys and selection titles. Nothing here calls a model or a database. The keys it
 * derives (candidate ids, claim keys, input hashes) are stored and must match what the
 * Python recipe derived for the same text.
 */

export const RECIPE_VERSION = "map-arguments-v1";
export const MANIFEST_VERSION = 1;
export const WINDOW_CHARS = 60_000;
export const WINDOW_OVERLAP_CHARS = 2_000;
export const MAX_QUOTES_PER_ITEM = 5;
export const KINDS = ["argument", "claim"];
export const VALENCES = ["positive", "negative", "neutral"];

export interface Transcript {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string | null;
  readonly text: string;
}

export const textHash = (t: Transcript) => sha256Hex(t.text);

/** What a result was generated from: every conversation and its exact text. */
export function sourceFingerprint(transcripts: readonly Transcript[]): string {
  const parts = sortedStrings(transcripts.map((t) => `${t.id}\x1f${textHash(t)}`));
  return sha256Hex(parts.join("\x1e"));
}

const len = (s: string) => [...s].length;
const slice = (s: string, a: number, b?: number) => [...s].slice(a, b).join("");

/**
 * Splits on line breaks into windows of at most `limit` characters; a longer line is cut
 * hard, and consecutive windows share up to `overlap` characters of trailing lines.
 */
export function transcriptWindows(
  textIn: string,
  limit = WINDOW_CHARS,
  overlap = WINDOW_OVERLAP_CHARS,
): string[] {
  const text = pyStrip(textIn);
  if (len(text) <= limit) return text ? [text] : [];
  const lines: string[] = [];
  for (let line of text.split("\n")) {
    while (len(line) > limit) {
      lines.push(slice(line, 0, limit));
      line = slice(line, limit);
    }
    lines.push(line);
  }
  const windows: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    let added = len(line) + (current.length ? 1 : 0);
    if (current.length && size + added > limit) {
      windows.push(current.join("\n"));
      const carry: string[] = [];
      let carrySize = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const previous = current[i] as string;
        if (carrySize + len(previous) + 1 > overlap) break;
        carry.unshift(previous);
        carrySize += len(previous) + 1;
      }
      current = carry;
      size = Math.max(0, carrySize - 1);
      // The carried overlap must still leave room for this line.
      while (current.length && size + len(line) + 1 > limit) {
        const gone = current.shift() as string;
        size = Math.max(0, size - len(gone) - 1);
      }
      added = len(line) + (current.length ? 1 : 0);
    }
    current.push(line);
    size += added;
  }
  if (current.length) windows.push(current.join("\n"));
  return windows;
}

const QUOTE_EDGES = "\"'“”‘’«»„ ";
const ELLIPSES = ["...", "…"];
const MIN_FRAGMENT_CHARS = 12;

/** The quote, whitespace-normalised, when it appears verbatim in the transcript. */
export function groundQuote(quote: string, transcriptKey: string): string | null {
  const text = pyStripChars(normalizeText(quote), QUOTE_EDGES);
  if (!text) return null;
  const key = casefold(text);
  if (transcriptKey.includes(key)) return text;
  const marker = ELLIPSES.find((m) => key.includes(m));
  if (!marker) return null;
  const fragments = key
    .replaceAll("…", "...")
    .split("...")
    .map((f) => pyStripChars(f, QUOTE_EDGES))
    .filter(Boolean);
  if (!fragments.length || fragments.some((f) => len(f) < MIN_FRAGMENT_CHARS)) return null;
  let position = 0;
  for (const fragment of fragments) {
    const found = pyFind(transcriptKey, fragment, position);
    if (found < 0) return null;
    position = found + len(fragment);
  }
  return text;
}

/** str.find with code point offsets, as Python counts them. */
export function pyFind(haystack: string, needle: string, start = 0): number {
  const h = [...haystack];
  const prefix = h.slice(0, start).join("");
  const idx = haystack.indexOf(needle, prefix.length);
  if (idx < 0) return -1;
  return [...haystack.slice(0, idx)].length;
}

export const candidateId = (conversationId: string, statement: string, kind: string) =>
  `c-${sha256Hex(`${conversationId}\x1f${kind}\x1f${normKey(statement)}`).slice(0, 20)}`;

export interface Candidate {
  id: string;
  conversation_id: string;
  statement: string;
  kind: string;
  valence: string;
  quotes: string[];
  order: [number, number];
}

/** Validates one extractor answer against its transcript; returns candidates and dropped count. */
export function shapeExtraction(
  raw: unknown,
  transcript: Transcript,
  windowIndex = 0,
): [Candidate[], number] {
  const transcriptKey = normKey(transcript.text);
  const values =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).items
      : undefined;
  const candidates: Candidate[] = [];
  let dropped = 0;
  (Array.isArray(values) ? values : []).forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      dropped++;
      return;
    }
    const v = value as Record<string, unknown>;
    const statement = normalizeText(v.statement || "");
    const kind = v.kind;
    const valence = v.valence;
    if (!statement || !KINDS.includes(kind as string) || !VALENCES.includes(valence as string)) {
      dropped++;
      return;
    }
    const quotes: string[] = [];
    const seen = new Set<string>();
    const evidence = v.evidence;
    for (const quote of Array.isArray(evidence) ? evidence : []) {
      const grounded = groundQuote(pyStr(quote), transcriptKey);
      if (grounded && !seen.has(casefold(grounded))) {
        seen.add(casefold(grounded));
        quotes.push(grounded);
      }
      if (quotes.length === MAX_QUOTES_PER_ITEM) break;
    }
    if (!quotes.length) {
      dropped++;
      return;
    }
    candidates.push({
      id: candidateId(transcript.id, statement, kind as string),
      conversation_id: transcript.id,
      statement,
      kind: kind as string,
      valence: valence as string,
      quotes,
      order: [windowIndex, index],
    });
  });
  return [candidates, dropped];
}

/** str(value or ""), for the values a model can return in a quote list. */
function pyStr(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (v === true) return "True";
  return JSON.stringify(v);
}

/** One conversation's candidates across windows: the same statement seen twice is one, with both quotes. */
export function mergeConversationCandidates(
  windows: readonly (readonly Candidate[])[],
): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const window of windows) {
    for (let candidate of window) {
      let existing = merged.get(candidate.id);
      if (existing && existing.valence !== candidate.valence) {
        // Same words, different attitude: kept apart under the whole valence.
        candidate = { ...candidate, id: `${candidate.id}-${candidate.valence}` };
        existing = merged.get(candidate.id);
      }
      if (!existing) {
        merged.set(candidate.id, { ...candidate, quotes: [...candidate.quotes] });
        continue;
      }
      const known = new Set(existing.quotes.map(casefold));
      for (const quote of candidate.quotes) {
        if (!known.has(casefold(quote)) && existing.quotes.length < MAX_QUOTES_PER_ITEM) {
          existing.quotes.push(quote);
          known.add(casefold(quote));
        }
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
}

export const embeddingInput = (statement: string) => normalizeText(statement);
export const inputHash = (text: string) => sha256Hex(embeddingInput(text));

/** A claim revision: its statement and the evidence it was checked with. */
export function claimKey(statement: string, quotes: Iterable<string>): string {
  const evidence = sortedStrings(new Set([...quotes].map(normKey))).join("\x1f");
  return sha256Hex(`${normKey(statement)}\x1e${evidence}`);
}

export const nodeId = (statement: string, kind: string) =>
  `a-${sha256Hex(`${kind}\x1f${normKey(statement)}`).slice(0, 20)}`;

export const MIN_TITLE_NODES = 3;
/** The whole selection goes to the model or none of it. */
export const MAX_TITLE_CHARS = 120_000;

export class SelectionTooSmall extends Error {}
export class SelectionTooLarge extends Error {}

export function titleSelectionKey(
  resultId: string,
  nodeIds: Iterable<string>,
  config: string,
): string {
  const ids = sortedStrings(new Set(nodeIds)).join("\x1f");
  return sha256Hex(`${resultId}\x1e${ids}\x1e${config}`);
}

/** One tagged line per selected v1 argument, in the order given. */
export function titleLines(
  args: readonly Record<string, unknown>[],
  verdicts: Readonly<Record<string, string | null>>,
): string[] {
  const lines = args.map((argument, i) => {
    let tag: string;
    if (argument.kind === "claim") {
      const verdict = verdicts[String(argument.claim_key || "")] || "unverified";
      tag = `[claim, ${verdict}]`;
    } else tag = "[argument]";
    return `${i + 1}. ${tag} ${argument.statement}`;
  });
  const total = lines.reduce((n, l) => n + len(l) + 1, 0);
  if (lines.length < MIN_TITLE_NODES)
    throw new SelectionTooSmall(`a title needs at least ${MIN_TITLE_NODES} arguments`);
  if (total > MAX_TITLE_CHARS)
    throw new SelectionTooLarge(
      `the selection is ${total} characters; the limit is ${MAX_TITLE_CHARS}`,
    );
  return lines;
}
