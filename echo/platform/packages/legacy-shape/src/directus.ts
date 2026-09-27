/**
 * Row values the way Directus serialised them, which is what the Python API returned
 * verbatim: timestamps as ISO 8601 in UTC with milliseconds, bigint keys as strings,
 * JSON columns parsed. Ported routes that hand rows back use this until the contract
 * gets its own response types.
 */

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)$/;

/** A Postgres timestamptz text value as Directus prints it: 2026-09-27T15:41:55.247Z. */
export function isoTimestamp(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const normal = v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(normal);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function value(v: unknown): unknown {
  if (typeof v === "bigint") return String(v);
  if (typeof v === "string" && PG_TIMESTAMP.test(v)) return isoTimestamp(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Converts every column of a row; nested JSON values are left as stored. */
export function directusRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = value(v);
  return out;
}

/** The same instant Directus would stamp into a date-created or date-updated field. */
export function nowIso(now: Date): string {
  return now.toISOString();
}

/** Python's datetime.isoformat() for an aware UTC datetime: microseconds and +00:00. */
export function pythonIso(now: Date): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

/**
 * A datetime as pydantic v2 serialises it in a response model: UTC as "Z", microseconds
 * only when non-zero ("2026-09-01T09:00:00Z", "2026-09-01T09:00:00.120000Z").
 */
export function pydanticIso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === "string" ? new Date(isoTimestamp(v) ?? v) : v;
  if (Number.isNaN(d.getTime())) return typeof v === "string" ? v : null;
  const base = d.toISOString();
  const ms = d.getUTCMilliseconds();
  return ms ? base.replace(/\.(\d{3})Z$/, ".$1000Z") : base.replace(/\.\d{3}Z$/, "Z");
}
