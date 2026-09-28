import { sha256Hex } from "./hashing";

/**
 * Text helpers that reproduce Python's str methods exactly, because their results feed
 * stored hashes (claim keys, input hashes, lineage keys) shared with the Python stack.
 */

/** The characters Python's str.split() treats as whitespace (not the same set as /\s/). */
const PY_WS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${PY_WS}]+`, "u");
const EDGE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");

/** str.split() with no argument. */
export function pySplit(text: string): string[] {
  return text.split(WS_RUN).filter((part) => part.length > 0);
}

/** str.strip() with no argument. */
export function pyStrip(text: string): string {
  return text.replace(EDGE, "");
}

/** str.strip(chars). */
export function pyStripChars(text: string, chars: string): string {
  const set = new Set([...chars]);
  const cs = [...text];
  let a = 0;
  let b = cs.length;
  while (a < b && set.has(cs[a] as string)) a++;
  while (b > a && set.has(cs[b - 1] as string)) b--;
  return cs.slice(a, b).join("");
}

/** " ".join(str(text or "").split()): whitespace collapsed, as Map normalised statements. */
export function normalizeText(text: unknown): string {
  return pySplit(String(text ?? "")).join(" ");
}

/** str.casefold(), by the upper-then-lower round trip that matches full case folding for the scripts in use. */
export function casefold(text: string): string {
  // Lower-casing applies the final-sigma rule; case folding maps every sigma to one form.
  return text.toUpperCase().toLowerCase().replaceAll("\u03c2", "\u03c3");
}

export const normKey = (text: unknown) => casefold(normalizeText(text));

export { sha256Hex };
