import type { Db } from "@dembrane/db";

/** A transaction handle; every storage function accepts it or the pool. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Conn = Db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids arrive from the URL. Directus answered a malformed one as "not found", while Postgres
 * would raise on the uuid cast, so lookups check the shape first.
 */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Current time as Directus wrote it into timestamp columns. */
export function iso(d: Date): string {
  return d.toISOString();
}
