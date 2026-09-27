/**
 * A timestamp as Directus served it to the old API (ISO 8601 in UTC with milliseconds),
 * so fields the frontend parses keep one format. Null stays null.
 */
export function directusTime(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  // Postgres prints "2026-09-01 09:00:00.5+00"; JavaScript wants the T and a full offset.
  const d = v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Parses a Postgres or ISO timestamp; null when absent or unreadable. */
export function parseTime(v: string | null | undefined): Date | null {
  const iso = directusTime(v);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
