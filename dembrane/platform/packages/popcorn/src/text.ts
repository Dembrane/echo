/**
 * Python's str methods and the popcorn text rules that depend on them. Their results feed
 * fingerprints, quote ids and what the room reads, so whitespace, case folding and word
 * boundaries follow Python exactly (JS \s and \b disagree with Python on non-ASCII text).
 */

/** The characters Python's str.split() treats as whitespace. */
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

/** str.casefold() for the scripts in use: upper then lower, one sigma. */
export function casefold(text: string): string {
  return text.toUpperCase().toLowerCase().replaceAll("ς", "σ");
}

/** re.sub(r"\s+", " ", text).strip().casefold() */
export function norm(text: string): string {
  return casefold(pyStrip(text.replace(new RegExp(`[${PY_WS}]+`, "gu"), " ")));
}

/** A Python \w character, for word boundaries that hold on non-ASCII text. */
const W = "[\\p{L}\\p{N}_]";

const ATTRIBUTES = new RegExp(
  `(?<!${W})(he|she|him|her|his|hers|himself|herself|introducing (him|her)self)(?!${W})`,
  "iu",
);
// A proper noun after the first word is a person or an organisation; "AI" is neither.
const PROPER = new RegExp(`(?<!^)(?<![.!?]\\s)(?<!${W})(?=${W})(?!AI(?!${W}))[A-Z][a-z]+`, "u");

/** True when a context line assigns a speaker: a pronoun, a name, an organisation. */
export function attributes(context: string): boolean {
  return ATTRIBUTES.test(context) || PROPER.test(pyStrip(context));
}
