/**
 * Deterministic PII redaction (pii_regex.py): EU and Dutch patterns applied in order,
 * before the model's own redaction pass. Python's \d and \b also match non-ASCII digits
 * and letters; these patterns are ASCII, which only differs on non-Latin digit scripts.
 */
const PATTERNS: readonly [RegExp, string][] = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted_email>"],
  [/\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d{4}){2,7}\b/g, "<redacted_iban>"],
  [
    /(?:\+31|0031)[\s\-.]?\(?\d{1,3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{2,4}[\s\-.]?\d{0,4}\b/g,
    "<redacted_phone>",
  ],
  [/\b06[\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}\b/g, "<redacted_phone>"],
  [
    /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}[\s\-.]?\d{0,4}\b/g,
    "<redacted_phone>",
  ],
  [/\b\d{4}\s?[A-Z]{2}\b/g, "<redacted_postcode>"],
  [/(?<!\d)\d{8,9}(?!\d)/g, "<redacted_bsn>"],
];

export function regexRedactPii(text: string): string {
  return PATTERNS.reduce((out, [re, placeholder]) => out.replace(re, placeholder), text);
}
