import postgres from "postgres";

const ADMIN = "postgres://dembrane:dembrane@localhost:5440/postgres";
export const DB_NAME = "dembrane";
export const DB_URL = `postgres://dembrane:dembrane@localhost:5440/${DB_NAME}`;

// Side effects of how each stack works rather than of what it does.
const IGNORED_TABLES = new Set([
  "directus_sessions",
  "directus_activity",
  "directus_revisions",
  "auth_session",
  "auth_verification",
  // Rate-limit counters: the old API keeps them in Redis.
  "platform_rate_limit",
  // New-only: the old API has no staff audit. Its rows are asserted by the staff tests.
  "staff_audit_event",
  // Presence (pings, visitors, recording meter): the old API keeps it in Redis.
  "platform_presence",
]);

export async function reset(
  template = process.env.PARITY_TEMPLATE ?? "parity_template_platform",
): Promise<void> {
  const sql = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${DB_NAME} and pid <> pg_backend_pid()`;
    await sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await sql.unsafe(`create database ${DB_NAME} template ${template}`);
  } finally {
    await sql.end();
  }
  await Bun.$`docker exec parity-valkey-1 valkey-cli flushall`.quiet();
}

/** Runs a scenario's setup on the scenario database: one script, or statements in order. */
export async function runSetup(setup: string | readonly string[]): Promise<void> {
  const statements = typeof setup === "string" ? [setup] : setup;
  if (!statements.length) return;
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    for (const s of statements) await sql.unsafe(s);
  } finally {
    await sql.end();
  }
}

export type Snapshot = Map<string, Map<string, Record<string, unknown>>>;

/** Every row of every table, keyed by primary key, so two snapshots can be diffed row by row. */
export async function snapshot(): Promise<Snapshot> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ table_name: string; pk: string[] }[]>`
      select c.relname as table_name,
             array_agg(a.attname order by array_position(i.indkey::int2[], a.attnum)) as pk
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_index i on i.indrelid = c.oid and i.indisprimary
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
      where c.relkind = 'r'
      group by c.relname`;
    const snap: Snapshot = new Map();
    for (const t of tables) {
      if (IGNORED_TABLES.has(t.table_name)) continue;
      const rows = await sql.unsafe(`select * from "${t.table_name}"`);
      const byKey = new Map<string, Record<string, unknown>>();
      for (const r of rows) byKey.set(t.pk.map((k) => String(r[k])).join("|"), r);
      snap.set(t.table_name, byKey);
    }
    return snap;
  } finally {
    await sql.end();
  }
}

/**
 * A Directus sign-in stamps last_access on the user row; a scenario that signs in during
 * `prepare` would otherwise show it as a change on the old side only.
 */
function withoutSignIn(table: string, row: Record<string, unknown>) {
  if (table !== "directus_users") return row;
  const { last_access: _a, last_page: _p, ...rest } = row;
  return rest;
}

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * Changed rows sort by their content with ids, hashes and times blanked, then by key:
 * rows minted during a scenario have random keys on each side, and Postgres returns rows
 * in heap order, which an UPDATE reshuffles, so both must still line up (a token pair's
 * access and refresh rows, say).
 */
function sortKey(key: string, row: Record<string, unknown>): string {
  const stable = JSON.stringify(row)
    .replace(UUID_ANY, "")
    .replace(/[0-9a-f]{32,}/gi, "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "");
  return `${stable}|${key}`;
}

export interface RowChange {
  readonly table: string;
  readonly kind: "insert" | "update" | "delete";
  readonly row: Record<string, unknown>;
}

/**
 * Changed rows by table and kind, in the order sortKey gives: physical order after an
 * UPDATE says nothing about behaviour, and keys minted per run differ between the sides.
 * Rows that tie keep the order Postgres returned them in.
 */
export function diff(before: Snapshot, after: Snapshot): RowChange[] {
  const changes: (RowChange & { key: string; seq: number })[] = [];
  let seq = 0;
  for (const [table, rows] of after) {
    const old = before.get(table) ?? new Map();
    for (const [k, row] of rows) {
      const prev = old.get(k);
      if (!prev) changes.push({ table, kind: "insert", row, key: sortKey("", row), seq: seq++ });
      else if (
        JSON.stringify(withoutSignIn(table, prev)) !== JSON.stringify(withoutSignIn(table, row))
      )
        changes.push({ table, kind: "update", row, key: sortKey(k, row), seq: seq++ });
    }
    for (const [k, row] of old)
      if (!rows.has(k)) changes.push({ table, kind: "delete", row, key: k, seq: seq++ });
  }
  return changes
    .sort(
      (a, b) =>
        `${a.table}${a.kind}`.localeCompare(`${b.table}${b.kind}`) ||
        a.key.localeCompare(b.key) ||
        a.seq - b.seq,
    )
    .map(({ table, kind, row }) => ({ table, kind, row }));
}
