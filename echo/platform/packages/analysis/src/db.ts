import type { Db } from "@echo/db";
import type postgres from "postgres";
import { AnalysisStoreError, ReferenceViolation } from "./contracts";

/**
 * Raw SQL for the analysis tables. They are guarded by the trigger functions carried in
 * migrations/0001_baseline_guards.sql (same-project references, legal transitions,
 * immutability of published rows), and the lifecycle depends on row locks taken in a
 * fixed order (scope, then run, then objects), which is plain SQL rather than a query
 * builder's business. Every statement here is parameterised.
 */

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Row = Record<string, unknown>;

/** The postgres.js client under the Drizzle handle, configured for text timestamps. */
export function clientOf(db: Db): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client;
}

/** A unique index refused a write; callers that expect races interpret it. */
export class UniqueViolation extends Error {}

interface PgError {
  readonly code?: string;
  readonly message?: string;
}

/** Maps database errors the way the Python store did: a trigger or check refusal is a ReferenceViolation. */
export function translate(err: unknown): Error {
  const e = err as PgError;
  if (e?.code === "23514") return new ReferenceViolation(String(e.message ?? "").trim());
  if (e?.code === "23505") return new UniqueViolation(String(e.message ?? "").trim());
  if (err instanceof Error && !("code" in err)) return err;
  return new AnalysisStoreError(String(e?.message ?? err).trim());
}

/**
 * A JSON column value. The app's client (configured by Drizzle) passes json and jsonb
 * parameters through untouched, so they are serialised here, once.
 */
export const J = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

export async function q<T extends Row = Row>(
  sql: Sql,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    return (await sql.unsafe(text, params as never[])) as unknown as T[];
  } catch (err) {
    throw translate(err);
  }
}

export async function one<T extends Row = Row>(
  sql: Sql,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  return (await q<T>(sql, text, params))[0] ?? null;
}

/** Rows a statement changed (UPDATE/DELETE without RETURNING). */
export async function count(
  sql: Sql,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  try {
    const r = await sql.unsafe(text, params as never[]);
    return r.count ?? 0;
  } catch (err) {
    throw translate(err);
  }
}

/** One transaction; anything thrown inside rolls it back. */
export async function transaction<T>(
  client: postgres.Sql,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  try {
    return (await client.begin(async (tx) => fn(tx))) as T;
  } catch (err) {
    throw translate(err);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether Python's uuid.UUID(str(value)) would accept it (hyphenated form). */
export function isUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bare = value.replace(/^urn:uuid:/i, "").replace(/^\{(.*)\}$/, "$1");
  return UUID.test(bare) || /^[0-9a-f]{32}$/i.test(bare);
}

export const uuids = (values: readonly unknown[]) =>
  values.map(String).filter((v) => isUuid(v)) as string[];

/** Postgres text timestamps compared in microseconds, which Date alone would round away. */
export function micros(ts: string | null | undefined): number {
  if (!ts) return Number.NEGATIVE_INFINITY;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts);
  if (!m) return Date.parse(ts) * 1000;
  const [, date, time, frac = "", zone = ""] = m;
  const tz = zone === "" || zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone;
  return Date.parse(`${date}T${time}${tz}`) * 1000 + Number(frac.padEnd(6, "0").slice(0, 6));
}

/** Python's datetime.isoformat() for a Postgres timestamptz text value. */
export function pyIso(ts: string | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}(?::?\d{2})?|Z)?$/.exec(ts);
  if (!m) return ts;
  const [, date, time, frac, zone] = m;
  const fraction = frac && Number(frac) !== 0 ? `.${frac.padEnd(6, "0").slice(0, 6)}` : "";
  let tz = "";
  if (zone === "Z") tz = "+00:00";
  else if (zone)
    tz =
      zone.length === 3
        ? `${zone}:00`
        : zone.includes(":")
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${date}T${time}${fraction}${tz}`;
}
