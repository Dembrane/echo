/**
 * The few Python behaviours the canvas output depends on, so the ported ledgers, prompts
 * and HTML read exactly as the Python produced them.
 */

export type Json = Record<string, unknown>;

/** Python's str() for the values canvas state holds. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

/** `str(value or "")`: Python falsiness first, then str(). */
export function orStr(v: unknown, fallback = ""): string {
  return truthy(v) ? pyStr(v) : fallback;
}

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** html.escape(s, quote=True). */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** " ".join(text.split()). */
export function normalizeWs(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** Python strip() of whitespace only. */
export function strip(s: string): string {
  return s.trim();
}

/** round() with banker's rounding on halves, as Python 3 does. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** datetime.now(timezone.utc).isoformat(): microseconds and +00:00. */
export function utcNowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

export function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `value if isinstance(value, list) else []`, keeping only dict items where Python assumed dicts. */
export function list(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

export function dict(v: unknown): Json {
  return isRecord(v) ? v : {};
}

/**
 * Parses an ISO timestamp the way `datetime.fromisoformat` does for the forms stored here
 * (a naive one is UTC). Null when it does not parse.
 */
export function parseDt(v: unknown): Date | null {
  if (!truthy(v)) return null;
  if (v instanceof Date) return v;
  let text = String(v).replace("Z", "+00:00");
  text = text.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!/[+-]\d{2}:\d{2}$/.test(text)) text = `${text}+00:00`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Postgres timestamptz text value as Directus printed it: 2026-09-27T15:41:55.247Z. */
export function directusTime(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = parseDt(v);
  return d ? d.toISOString() : String(v);
}
