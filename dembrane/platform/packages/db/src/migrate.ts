import { assetPath } from "@dembrane/core";
import { sql as raw } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
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
 * with them held back while later migrations still apply. A migration is pending when its
 * journal entry is not recorded, not when it is newer than the latest recorded one, so a run
 * without the hold applies a held contract even after newer migrations went in.
 */
export interface MigrateOptions {
  readonly holdContract?: boolean;
  /**
   * APP_ENV of the database being migrated. Required so no caller can forget it: outside
   * ARCHIVE_EXEMPT_ENVS, a contract migration runs only once its archive is recorded, and
   * an unset value counts as not exempt.
   */
  readonly appEnv: string | undefined;
  /**
   * How long a statement of a no-transaction migration may wait on a lock (a concurrent index
   * build waits for every transaction that could still write the table) before it is tried again
   * and, after `LOCK_ATTEMPTS`, fails. Postgres interval syntax; the default is `NO_TRANSACTION_LOCK_TIMEOUT`.
   */
  readonly noTransactionLockTimeout?: string;
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
  const session = await lockedSession(url);
  const { sql } = session;
  try {
    // An empty database has no data a contract migration could drop, so a new environment
    // (a new region, a new cluster) starts without an archive.
    const empty = !(await one<boolean>(sql`select to_regclass('public.project') is not null as v`));
    const adoptedBaseline = await adoptBaseline(sql);
    const recorded = await recordedMigrations(sql);
    const pending = (await chain()).filter(
      (m) => !recorded.has(m.folderMillis) && !(opts.holdContract && isContract(m.tag)),
    );
    if (!empty && !opts.holdContract && !ARCHIVE_EXEMPT_ENVS.includes(opts.appEnv ?? "")) {
      const unarchived = await unarchivedContracts(sql, pending);
      if (unarchived.length) throw new ContractArchiveMissing(unarchived, opts.appEnv);
    }
    await apply(session, pending, opts.noTransactionLockTimeout ?? NO_TRANSACTION_LOCK_TIMEOUT);
    return { adoptedBaseline, applied: pending.length };
  } finally {
    session.close();
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}

/**
 * The migration lost the connection that holds its advisory lock. The driver opens a new
 * connection by itself, which holds no lock: carrying on there would run migrations beside
 * another job. Nothing more was run; the migrate job is safe to run again.
 */
export class MigrationLockLost extends Error {
  constructor() {
    super(
      "the migration's database connection dropped, and the advisory lock that keeps two migrate jobs apart went with it. Nothing more was run; run the migrate job again.",
    );
    this.name = "MigrationLockLost";
  }
}

/** The one connection a migration runs on, and a check that it is still the one that took the lock. */
export interface LockedSession {
  readonly sql: postgres.Sql;
  /** Backend process of the connection that took the lock. */
  readonly pid: number;
  /** Throws MigrationLockLost when that connection is gone, before anything runs on a new one. */
  check(): Promise<void>;
  /** The caller is closing the connection on purpose. */
  close(): void;
}

/**
 * Connects and takes the advisory lock. The lock belongs to the connection, so the connection is
 * watched: the driver's close callback marks it lost the moment it drops, and the backend
 * process is compared before each step, so a silent reconnect is never taken for the same session.
 */
export async function lockedSession(url: string): Promise<LockedSession> {
  let lost = false;
  let closing = false;
  const sql = connect(url, {
    max: 1,
    onnotice: () => {},
    onclose: () => {
      if (!closing) lost = true;
    },
  });
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    const pid = await one<number>(sql`select pg_backend_pid()::int as v`);
    return {
      sql,
      pid,
      close: () => {
        closing = true;
      },
      async check() {
        if (lost) throw new MigrationLockLost();
        if ((await one<number>(sql`select pg_backend_pid()::int as v`)) !== pid)
          throw new MigrationLockLost();
      },
    };
  } catch (err) {
    closing = true;
    await sql.end().catch(() => {});
    throw err;
  }
}

const isContract = (tag: string) => tag.includes("_contract_");

interface Migration {
  readonly tag: string;
  /** The journal entry's `when`; drizzle records it as created_at and it names the migration. */
  readonly folderMillis: number;
  readonly hash: string;
  readonly sql: readonly string[];
}

/** Every migration in journal order, read and split the way drizzle's migrator reads them. */
async function chain(): Promise<Migration[]> {
  const files = readMigrationFiles({ migrationsFolder: migrations() });
  const journal = (await Bun.file(
    assetPath("db", "migrations", "meta", "_journal.json"),
  ).json()) as { entries: { tag: string }[] };
  const all = journal.entries.map((e, i) => {
    const m = files[i];
    if (!m) throw new Error(`migration ${e.tag} is in the journal but not on disk`);
    return { tag: e.tag, folderMillis: m.folderMillis, hash: m.hash, sql: m.sql };
  });
  // A migration is known by its journal timestamp, so two sharing one would hide each other.
  if (new Set(all.map((m) => m.folderMillis)).size !== all.length)
    throw new Error("two journal entries share a `when`; every migration needs its own");
  return all;
}

/**
 * The journal timestamps recorded in drizzle's history. Recorded by timestamp, not hash: a
 * hash changes when an applied file is reformatted, and treating that as pending would run
 * the migration a second time.
 */
async function recordedMigrations(sql: postgres.Sql): Promise<Set<number>> {
  // Two statements on purpose: Postgres resolves every table in a query while planning.
  if (
    !(await one<boolean>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as v`))
  )
    return new Set();
  const rows = await sql`select created_at from drizzle.__drizzle_migrations`;
  return new Set(rows.map((r) => Number(r.created_at)));
}

/**
 * Marks a migration that cannot run inside a transaction (CREATE INDEX CONCURRENTLY): its
 * first line is this comment. Such a migration runs on its own, statement by statement, after
 * the ones before it have committed, and is recorded when its last statement has finished.
 * Write each of its statements so that running it again from the first is safe.
 */
const NO_TRANSACTION = /^\s*--\s*migrate:\s*no-transaction\b/;
const outsideTransaction = (m: Migration) => NO_TRANSACTION.test(m.sql[0] ?? "");

/**
 * Runs the pending migrations in journal order and records each as drizzle's migrator does
 * (same table, hash and created_at), so drizzle-kit and older builds read the same history.
 * Consecutive migrations run in one transaction (retried on a lock timeout or a deadlock);
 * one marked no-transaction ends the run before it, runs alone outside a transaction, and the
 * ones after it start a new run.
 */
async function apply(
  session: LockedSession,
  pending: readonly Migration[],
  noTransactionLockTimeout: string,
): Promise<void> {
  const { sql } = session;
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  let run: Migration[] = [];
  for (const m of pending) {
    if (!outsideTransaction(m)) {
      run.push(m);
      continue;
    }
    await applyInTransaction(session, run);
    run = [];
    await applyOutsideTransaction(session, m, noTransactionLockTimeout);
  }
  await applyInTransaction(session, run);
}

/**
 * A migration marked no-transaction, statement by statement. A statement waits for a lock for
 * at most `lockTimeout` (a concurrent build waits for every transaction that could still write
 * the table, and a long-open one must not hold a deploy), and is tried again a few times like a
 * transactional run. Before each build the index it names is looked at: a valid one is left for
 * `IF NOT EXISTS` to skip, so a deploy that follows a build which outlived its job does not
 * start it over; only an invalid leftover (a build that failed or was cancelled) is dropped.
 */
async function applyOutsideTransaction(
  session: LockedSession,
  m: Migration,
  lockTimeout: string,
): Promise<void> {
  const { sql } = session;
  await session.check();
  await sql.unsafe(`set lock_timeout = '${lockTimeout}'`);
  try {
    for (const statement of m.sql) {
      for (let attempt = 1; ; attempt++) {
        try {
          await session.check();
          await dropInvalidIndexOf(sql, statement);
          await sql.unsafe(statement);
          break;
        } catch (err) {
          if (!isRetryableLock(err) || attempt >= LOCK_ATTEMPTS) throw err;
          await Bun.sleep(LOCK_BACKOFF_MS * attempt + Math.random() * LOCK_BACKOFF_MS);
        }
      }
    }
    await session.check();
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
  } finally {
    await sql.unsafe("reset lock_timeout").catch(() => {});
  }
}

// The first statement of a file carries the comment lines above it.
const BUILDS_AN_INDEX =
  /^(?:\s*--[^\n]*\n)*\s*create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z0-9_]+)"?/i;

/** Drops the index a CREATE INDEX CONCURRENTLY statement names when it exists but is invalid; a valid one stays. */
async function dropInvalidIndexOf(sql: postgres.Sql, statement: string): Promise<void> {
  const name = BUILDS_AN_INDEX.exec(statement)?.[1];
  if (!name) return;
  const [row] = await sql<{ valid: boolean }[]>`
    select i.indisvalid as valid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = ${name} and n.nspname = current_schema()`;
  if (row && !row.valid) await sql.unsafe(`drop index concurrently if exists "${name}"`);
}

async function applyInTransaction(
  session: LockedSession,
  pending: readonly Migration[],
): Promise<void> {
  if (!pending.length) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await session.check();
      await drizzle(session.sql).transaction(async (tx) => {
        // The transaction began on the connection that holds the lock, or it does not run.
        const [me] = await tx.execute(raw`select pg_backend_pid()::int as pid`);
        if ((me as { pid: number } | undefined)?.pid !== session.pid) throw new MigrationLockLost();
        // Fail fast instead of queueing live traffic behind a lock we wait for.
        await tx.execute(raw.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`));
        for (const m of pending) {
          for (const statement of m.sql) await tx.execute(raw.raw(statement));
          await tx.execute(
            raw`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`,
          );
        }
      });
      return;
    } catch (err) {
      // The whole run rolled back, so trying again is safe.
      if (!isRetryableLock(err) || attempt >= LOCK_ATTEMPTS) throw err;
      await Bun.sleep(LOCK_BACKOFF_MS * attempt + Math.random() * LOCK_BACKOFF_MS);
    }
  }
}

const LOCK_TIMEOUT = "5s";
/** A concurrent build waits for old transactions, so it waits longer than a transactional run; three tries stay well inside the job's limit. */
export const NO_TRANSACTION_LOCK_TIMEOUT = "30s";
export const LOCK_ATTEMPTS = 3;
const LOCK_BACKOFF_MS = 1000;

/** A lock timeout (55P03) or a deadlock (40P01): the run rolled back whole, so trying again is safe. */
export function isRetryableLock(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  return code === "55P03" || code === "40P01";
}

async function adoptBaseline(sql: postgres.Sql): Promise<boolean> {
  const hasSchema = await one<boolean>(sql`select to_regclass('public.project') is not null as v`);
  if (!hasSchema) return false;
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  if ((await one<number>(sql`select count(*)::int as v from drizzle.__drizzle_migrations`)) > 0)
    return false;
  for (const m of await chain()) {
    if (!BASELINE_TAGS.includes(m.tag)) continue;
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
  }
  return true;
}

/**
 * Contract migrations this run would apply that have no archive row: the same pending list
 * the run applies, so a contract released after newer migrations is checked too.
 */
async function unarchivedContracts(
  sql: postgres.Sql,
  pendingMigrations: readonly Migration[],
): Promise<string[]> {
  const pending = pendingMigrations.filter((m) => isContract(m.tag)).map((m) => m.tag);
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
