/** Time-ordered ids minted in the application, never by the database, so a row's id is known before it is written. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
