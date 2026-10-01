/**
 * Compares the new database with the frozen old one: exact row counts for every table, then
 * a checksum of a deterministic sample of rows per table. Reads both sides; writes nothing.
 * Exits non-zero on any unexpected difference, so it can gate the DNS switch.
 *
 *   SOURCE_URL=postgres://...do...:25060/defaultdb?sslmode=require \
 *   TARGET_URL=postgres://echo_owner:...@127.0.0.1:5432/echo \
 *   bun legacy/ops/verify-db.ts [--sample 200] [--json out.json]
 *
 * Expected differences, reported but not failures:
 *   - tables whose rows were left behind on purpose (EXCLUDE_DATA, see lib.sh): target 0;
 *   - tables the contract migration dropped: absent from the target;
 *   - tables only the new stack has (auth_*, accounts, dbos): absent from the source;
 *   - rows the migrate job adds (identity sync, legal texts) in tables it owns.
 * Everything else must match exactly.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const SAMPLE = Number(flag("--sample", "200"));
const JSON_OUT = flag("--json", "");

const sourceUrl = process.env.SOURCE_URL;
const targetUrl = process.env.TARGET_URL;
if (!sourceUrl || !targetUrl) throw new Error("SOURCE_URL and TARGET_URL are required");

// Both sessions are read-only and in UTC, so a row prints the same text on either server.
const session = { default_transaction_read_only: true, TimeZone: "UTC", statement_timeout: 0 };
const src = postgres(sourceUrl, { max: 4, connection: session, onnotice: () => {} });
const tgt = postgres(targetUrl, { max: 4, connection: session, onnotice: () => {} });

const DEFAULT_EXCLUDE = [
  "directus_revisions",
  "directus_activity",
  "conversation_segment",
  "conversation_segment_conversation_chunk",
  "aspect_segment",
  "lightrag_chunk_graph_map",
  "lightrag_doc_chunks",
  "lightrag_doc_full",
  "lightrag_doc_status",
  "lightrag_llm_cache",
  "lightrag_vdb_entity",
  "lightrag_vdb_relation",
  "lightrag_vdb_transcript",
];
const excluded = new Set(
  process.env.EXCLUDE_DATA !== undefined
    ? process.env.EXCLUDE_DATA.split(/\s+/).filter(Boolean)
    : DEFAULT_EXCLUDE,
);
// Rows the migrate job writes into tables the old stack also has; counted, not compared.
const writtenByMigrate = new Set(["legal_text"]);

const tables = async (sql: postgres.Sql) =>
  new Set(
    (await sql`select tablename from pg_tables where schemaname = 'public' order by 1`).map(
      (r) => r.tablename as string,
    ),
  );

async function count(sql: postgres.Sql, t: string): Promise<number> {
  const [r] = await sql.unsafe(`select count(*)::bigint as n from public."${t}"`);
  return Number(r?.n ?? 0);
}

/** Primary key columns of a table, in key order; empty when it has none. */
async function pkey(sql: postgres.Sql, t: string): Promise<string[]> {
  const rows = await sql`
    select a.attname from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = ${`public."${t}"`}::regclass and i.indisprimary
    order by array_position(i.indkey, a.attnum)`;
  return rows.map((r) => r.attname as string);
}

async function columns(sql: postgres.Sql, t: string): Promise<string[]> {
  const rows = await sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${t} order by ordinal_position`;
  return rows.map((r) => r.column_name as string);
}

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

/**
 * md5 over the text of SAMPLE rows chosen by the hash of their key, over the columns both
 * sides have. The same rows are picked on both sides without shipping ids between them.
 */
async function sampleChecksum(t: string): Promise<{ src: string; tgt: string } | null> {
  const key = await pkey(src, t);
  if (!key.length) return null;
  const tgtCols = new Set(await columns(tgt, t));
  const cols = (await columns(src, t)).filter((c) => tgtCols.has(c));
  const keyExpr = key.map((k) => `${q(k)}::text`).join(" || '|' || ");
  const rowExpr = `concat_ws('|', ${cols.map((c) => `${q(c)}::text`).join(", ")})`;
  const stmt = `select coalesce(md5(string_agg(r, E'\\n' order by k)), 'empty') as h from (
      select ${keyExpr} as k, ${rowExpr} as r from public."${t}"
      order by md5(${keyExpr}) limit ${SAMPLE}) s`;
  const [a] = await src.unsafe(stmt);
  const [b] = await tgt.unsafe(stmt);
  return { src: a?.h as string, tgt: b?.h as string };
}

interface Row {
  table: string;
  source: number | null;
  target: number | null;
  status: "ok" | "excluded" | "dropped" | "new" | "migrate-owned" | "MISMATCH";
  checksum?: "ok" | "MISMATCH" | "no-key" | "skipped";
}

const started = performance.now();
const [srcTables, tgtTables] = await Promise.all([tables(src), tables(tgt)]);
const all = [...new Set([...srcTables, ...tgtTables])].sort();
const out: Row[] = [];

for (const t of all) {
  const inSrc = srcTables.has(t);
  const inTgt = tgtTables.has(t);
  const [s, n] = await Promise.all([
    inSrc ? count(src, t) : Promise.resolve(null),
    inTgt ? count(tgt, t) : Promise.resolve(null),
  ]);
  let status: Row["status"];
  if (!inTgt) status = "dropped";
  else if (!inSrc) status = "new";
  else if (excluded.has(t)) status = n === 0 ? "excluded" : "MISMATCH";
  else if (writtenByMigrate.has(t)) status = (n ?? 0) >= (s ?? 0) ? "migrate-owned" : "MISMATCH";
  else status = s === n ? "ok" : "MISMATCH";
  const row: Row = { table: t, source: s, target: n, status };
  if (status === "ok" && (s ?? 0) > 0) {
    const c = await sampleChecksum(t);
    row.checksum = c === null ? "no-key" : c.src === c.tgt ? "ok" : "MISMATCH";
  }
  out.push(row);
}

await Promise.all([src.end(), tgt.end()]);

const bad = out.filter((r) => r.status === "MISMATCH" || r.checksum === "MISMATCH");
const by = (s: Row["status"]) => out.filter((r) => r.status === s).length;
for (const r of out.filter((r) => r.status !== "ok" || r.checksum === "MISMATCH"))
  console.log(
    `${r.status.padEnd(13)} ${r.table.padEnd(42)} source=${r.source ?? "-"} target=${r.target ?? "-"}${r.checksum === "MISMATCH" ? " checksum=MISMATCH" : ""}`,
  );
const sumRows = (k: "source" | "target") =>
  out.filter((r) => r.status === "ok").reduce((a, r) => a + (r[k] ?? 0), 0);
console.log(
  `tables: ${by("ok")} equal (${sumRows("source")} rows, ${out.filter((r) => r.checksum === "ok").length} sample checksums equal), ` +
    `${by("excluded")} left behind, ${by("dropped")} dropped, ${by("new")} new, ${by("migrate-owned")} migrate-owned, ` +
    `${bad.length} mismatched; ${Math.round(performance.now() - started) / 1000}s`,
);
if (JSON_OUT) await Bun.write(JSON_OUT, JSON.stringify(out, null, 2));
process.exit(bad.length ? 1 : 0);
