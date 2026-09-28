import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath } from "@dembrane/core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import { connect } from "./connection";

/** What the migrate job's boot check requires. */
export const MIGRATE_ASSETS: readonly string[] = ["db/migrations/meta/_journal.json"];
const migrations = () => assetPath("db", "migrations");
const BASELINE_TAGS = ["0000_baseline", "0001_baseline_guards"];
// Any fixed number works; every migrating process must use the same one.
const LOCK_KEY = 72_1405_2026;

/**
 * Contract migrations (tag contains "_contract_") drop what the old stack still reads.
 * They run at cutover. A database the old stack also serves (the parity template) is built
 * with them held back; it is rebuilt from scratch, never migrated forward, because drizzle
 * applies only migrations newer than the last applied one and would skip a held contract.
 */
export interface MigrateOptions {
  readonly holdContract?: boolean;
  /**
   * APP_ENV of the database being migrated. Required so no caller can forget it: outside
   * ARCHIVE_EXEMPT_ENVS, a contract migration runs only once its archive is recorded, and
   * an unset value counts as not exempt.
   */
  readonly appEnv: string | undefined;
}

/**
 * Environments whose data is disposable (built from seeds or a template), so a contract
 * migration may drop tables there without an archive. Every other environment holds data
 * someone may need back (echo-next, prod), and 0012 alone drops about 21 GB of it.
 */
export const ARCHIVE_EXEMPT_ENVS: readonly string[] = ["local", "test", "preview"];
export const ARCHIVE_SCRIPT = "packages/db/scripts/archive-tables.sh";

/**
 * The archive ledger. archive-tables.sh writes one row per contract migration after every
 * table is dumped and the manifest uploaded; migrate reads it. It sits in the drizzle schema
 * beside the migration history because it is migration bookkeeping, not app data, and it
 * lives in the database it vouches for, so an archive of another database never counts.
 * The script creates the same table; keep the two definitions identical.
 */
export const ARCHIVE_LEDGER_DDL = `create schema if not exists drizzle;
create table if not exists drizzle.contract_archive (
  migration text primary key,
  archived_at timestamptz not null default now(),
  destination text not null,
  manifest text not null
)`;

export class ContractArchiveMissing extends Error {
  constructor(
    readonly migrations: readonly string[],
    readonly appEnv: string | undefined,
  ) {
    super(
      `Refusing to apply contract migration ${migrations.join(", ")} on APP_ENV=${appEnv ?? "<unset>"}: ` +
        "no archive of the tables it drops is recorded in this database. Nothing was migrated. " +
        `Run DATABASE_URL=<owner URL of this database> ${ARCHIVE_SCRIPT} first: it dumps each ` +
        "table to gs://dembrane-echo-archive and records the archive in drizzle.contract_archive. " +
        "Then run the migrate job again.",
    );
    this.name = "ContractArchiveMissing";
  }
}

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
export async function migrate(url: string, opts: MigrateOptions): Promise<MigrateResult> {
  const sql = connect(url, { max: 1, onnotice: () => {} });
  const folder = opts.holdContract ? withoutContract() : null;
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    const adoptedBaseline = await adoptBaseline(sql);
    if (!opts.holdContract && !ARCHIVE_EXEMPT_ENVS.includes(opts.appEnv ?? "")) {
      const unarchived = await unarchivedContracts(sql);
      if (unarchived.length) throw new ContractArchiveMissing(unarchived, opts.appEnv);
    }
    const before = await countApplied(sql);
    await drizzleMigrate(drizzle(sql), { migrationsFolder: folder ?? migrations() });
    const applied = (await countApplied(sql)) - before;
    return { adoptedBaseline, applied };
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
}

/** A copy of the migrations folder whose journal leaves out the contract migrations. */
function withoutContract(): string {
  const dir = mkdtempSync(join(tmpdir(), "echo-migrations-"));
  cpSync(migrations(), dir, { recursive: true });
  const path = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => !e.tag.includes("_contract_"));
  writeFileSync(path, JSON.stringify(journal, null, 2));
  return dir;
}

async function adoptBaseline(sql: postgres.Sql): Promise<boolean> {
  const hasSchema = await one<boolean>(sql`select to_regclass('public.project') is not null as v`);
  if (!hasSchema) return false;
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  if ((await one<number>(sql`select count(*)::int as v from drizzle.__drizzle_migrations`)) > 0)
    return false;
  const files = readMigrationFiles({ migrationsFolder: migrations() });
  const journal = (await Bun.file(
    assetPath("db", "migrations", "meta", "_journal.json"),
  ).json()) as {
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

/**
 * Contract migrations this run would apply that have no archive row. Pending is decided the
 * way drizzle's migrator decides it: every migration newer than the latest applied one.
 */
async function unarchivedContracts(sql: postgres.Sql): Promise<string[]> {
  const files = readMigrationFiles({ migrationsFolder: migrations() });
  const journal = (await Bun.file(
    assetPath("db", "migrations", "meta", "_journal.json"),
  ).json()) as { entries: { tag: string }[] };
  const hasHistory = await one<boolean>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as v`,
  );
  const [last] = hasHistory
    ? await sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`
    : [];
  const pending = journal.entries
    .filter(
      (e, i) =>
        e.tag.includes("_contract_") &&
        (!last || Number(last.created_at) < (files[i]?.folderMillis ?? 0)),
    )
    .map((e) => e.tag);
  if (!pending.length) return [];
  const hasLedger = await one<boolean>(
    sql`select to_regclass('drizzle.contract_archive') is not null as v`,
  );
  const archived = hasLedger
    ? new Set(
        (await sql`select migration from drizzle.contract_archive`).map(
          (r) => r.migration as string,
        ),
      )
    : new Set<string>();
  return pending.filter((tag) => !archived.has(tag));
}

/** Records an archive as archive-tables.sh does; for tests and for recovery by hand. */
export async function recordContractArchive(
  url: string,
  row: { migration: string; destination: string; manifest: string },
): Promise<void> {
  const sql = connect(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(ARCHIVE_LEDGER_DDL);
    await sql`insert into drizzle.contract_archive (migration, destination, manifest)
      values (${row.migration}, ${row.destination}, ${row.manifest})
      on conflict (migration) do update set archived_at = now(),
        destination = excluded.destination, manifest = excluded.manifest`;
  } finally {
    await sql.end();
  }
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

/**
 * Gives the runtime login data rights and nothing else: no DDL, no ownership. Default
 * privileges cover tables later migrations create, so a new table never needs a manual grant.
 */
export async function grantRuntimeRole(
  url: string,
  role: string,
  schemas: readonly string[],
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`invalid role name ${role}`);
  const sql = connect(url, { max: 1, onnotice: () => {} });
  try {
    for (const schema of schemas) {
      if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name ${schema}`);
      await sql.unsafe(`grant usage on schema ${schema} to ${role}`);
      await sql.unsafe(
        `grant select, insert, update, delete on all tables in schema ${schema} to ${role}`,
      );
      await sql.unsafe(
        `grant usage, select, update on all sequences in schema ${schema} to ${role}`,
      );
      await sql.unsafe(`grant execute on all functions in schema ${schema} to ${role}`);
      await sql.unsafe(
        `alter default privileges in schema ${schema} grant select, insert, update, delete on tables to ${role}`,
      );
      await sql.unsafe(
        `alter default privileges in schema ${schema} grant usage, select, update on sequences to ${role}`,
      );
      await sql.unsafe(
        `alter default privileges in schema ${schema} grant execute on functions to ${role}`,
      );
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  const r = await migrate(url, {
    holdContract: process.env.MIGRATE_HOLD_CONTRACT === "1",
    appEnv: process.env.APP_ENV,
  });
  process.stdout.write(
    `${JSON.stringify({ severity: "INFO", message: "migrations complete", ...r })}\n`,
  );
}
