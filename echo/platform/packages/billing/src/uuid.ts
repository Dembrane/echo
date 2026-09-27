const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids in paths are UUIDs; anything else cannot name a row, so it is simply not found. */
export function isUuid(s: string | null | undefined): s is string {
  return typeof s === "string" && UUID.test(s);
}
