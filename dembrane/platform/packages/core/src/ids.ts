/** Time-ordered ids minted in the application, never by the database, so a row's id is known before it is written. */
export function newId(): string {
  return Bun.randomUUIDv7();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids in paths are UUIDs; anything else cannot name a row, so it is simply not found. */
export function isUuid(s: string | null | undefined): s is string {
  return typeof s === "string" && UUID.test(s);
}
