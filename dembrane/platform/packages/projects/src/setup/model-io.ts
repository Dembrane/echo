import { withoutClosingFence } from "@dembrane/llm";

/**
 * What every setup model call shares (suggestions in model.ts, the digest in digest-model.ts):
 * the host's material fenced as data, and the JSON answer read back. Neither is the defence
 * (the schema and the rules after the answer are); they only help.
 */

/** A source's own text can never close its fence or open a new one. */
export const neutraliseFences = (text: string) => text.replace(/<<<|>>>/g, "‹‹‹");

/** The host's material between `<<<LABEL>>>` and `<<<END LABEL>>>`, its own fences neutralised. */
export const fence = (label: string, text: string) =>
  `<<<${label}>>>\n${neutraliseFences(text)}\n<<<END ${label}>>>`;

/** The model's JSON object, a code fence around it allowed; null when it is not one. */
export function jsonAnswer(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(withoutClosingFence(text.trim().replace(/^```(?:json)?\s*/i, "")));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

// Readers for an answer's fields: a missing or mistyped field reads as empty.
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const strings = (v: unknown): string[] => list(v).map(str).filter(Boolean);
export const objects = (v: unknown): Record<string, unknown>[] =>
  list(v).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

/** The proposed key terms of an answer, those without a term left out. */
export const termsOf = (v: unknown): { term: string; reason: string }[] =>
  objects(v)
    .map((t) => ({ term: str(t.term), reason: str(t.reason) }))
    .filter((t) => t.term);
