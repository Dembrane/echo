import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS = new URL("../migrations", import.meta.url).pathname;
const BASELINE_TAGS = ["0000_baseline", "0001_baseline_guards"];
// Any fixed number works; every migrating process must use the same one.
const LOCK_KEY = 72_1405_2026;

export interface MigrateResult {
  readonly adoptedBaseline: boolean;
  readonly applied: number;
}

/**
 * Brings a database to the latest migration. Runs as its own Cloud Run job before a
 * rollout, with the owner login (DDL rights); the API's runtime login never has them.
 *
 * A database created by Directus already has the baseline schema but no migration
 * history. It is adopted: the baseline is recorded as applied, never executed, and
 * later migrations run normally. An advisory lock keeps two jobs from racing.
 */
export async function migrate(url: string): Promise<MigrateResult> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    const adoptedBaseline = await adoptBaseline(sql);
    const before = await countApplied(sql);
    await drizzleMigrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    const applied = (await countApplied(sql)) - before;
    return { adoptedBaseline, applied };
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}

async function adoptBaseline(sql: postgres.Sql): Promise<boolean> {
  const hasSchema = await one<boolean>(sql`select to_regclass('public.project') is not null as v`);
  if (!hasSchema) return false;
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  if ((await one<number>(sql`select count(*)::int as v from drizzle.__drizzle_migrations`)) > 0)
    return false;
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const journal = (await Bun.file(`${MIGRATIONS}/meta/_journal.json`).json()) as {
    entries: { tag: string }[];
  };
  for (const [i, entry] of journal.entries.entries()) {
    if (!BASELINE_TAGS.includes(entry.tag)) continue;
    const m = files[i];
    if (!m) throw new Error(`migration ${entry.tag} is in the journal but not on disk`);
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
  }
  return true;
}

async function countApplied(sql: postgres.Sql): Promise<number> {
  // Two statements on purpose: Postgres resolves every table in a query while planning,
  // even inside a CASE branch that never runs.
  if (
    !(await one<boolean>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as v`))
  )
    return 0;
  return one<number>(sql`select count(*)::int as v from drizzle.__drizzle_migrations`);
}

/** First column of the single row a scalar query returns. */
async function one<T>(query: postgres.PendingQuery<postgres.Row[]>): Promise<T> {
  const [row] = await query;
  if (!row) throw new Error("scalar query returned no row");
  return row.v as T;
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  const r = await migrate(url);
  process.stdout.write(
    `${JSON.stringify({ severity: "INFO", message: "migrations complete", ...r })}\n`,
  );
}
