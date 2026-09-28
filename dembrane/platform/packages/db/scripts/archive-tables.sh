#!/usr/bin/env bash
# Copies tables to cold storage before a contract migration drops them. Runs once at
# cutover, against the database about to be migrated, before the migration job; the
# migration header names the tables. Reads the tables with pg_dump and count(*); its one
# write is the row in drizzle.contract_archive that lets the migrate job apply the
# contract migration outside local, test and preview. The row is written last, so a run
# that fails on any table leaves the migration blocked.
#
# One custom-format dump per table (restore with pg_restore -t), plus manifest.tsv with
# each table's exact row count and size at dump time. A table that does not exist is
# recorded as absent and skipped, since some (lightrag_*) exist on prod only.
#
#   DATABASE_URL=postgres://... packages/db/scripts/archive-tables.sh            the default set
#   DATABASE_URL=postgres://... packages/db/scripts/archive-tables.sh view aspect  named tables
#
# ARCHIVE_DEST  gs:// prefix or a local directory (default gs://dembrane-web-prod-echo-archive).
#               Objects land under <dest>/<database>/<UTC stamp>/.
# PG_DUMP, PSQL override the binaries, e.g. "docker exec -i parity-db-1 pg_dump" for a
#               local run. pg_dump must be at least the server's major version.
# SOURCE_DATABASE_URL  read the tables from this database instead, opened read-only: the
#               frozen old database at cutover, whose dead tables are not copied across. The
#               ledger row still goes to DATABASE_URL, which may be left unset when no row is
#               written (ARCHIVE_FOR empty), e.g. an archive taken before the window.
# ARCHIVE_FOR   the contract migration this archive clears. Defaults to
#               0012_contract_dead_features for the default set; a named table list clears
#               nothing unless ARCHIVE_FOR is given, so a partial archive cannot unblock it.
set -euo pipefail

src_url="${SOURCE_DATABASE_URL:-${DATABASE_URL:?URL of the database to archive from}}"
dest_root="${ARCHIVE_DEST:-gs://dembrane-web-prod-echo-archive}"
pg_dump_cmd=(${PG_DUMP:-pg_dump})
psql_cmd=(${PSQL:-psql})

# The contract migration 0012_contract_dead_features drops these.
default_tables=(
  view aspect aspect_segment insight project_analysis_run
  conversation_segment conversation_segment_conversation_chunk
  lightrag_chunk_graph_map lightrag_doc_chunks lightrag_doc_full lightrag_doc_status
  lightrag_llm_cache lightrag_vdb_entity lightrag_vdb_relation lightrag_vdb_transcript
  workspace_request
)
tables=("$@")
archive_for="${ARCHIVE_FOR:-}"
if [[ ${#tables[@]} -eq 0 ]]; then
  tables=("${default_tables[@]}")
  archive_for="${ARCHIVE_FOR:-0012_contract_dead_features}"
fi

if [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
  export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on"
fi
if [[ -n "$archive_for" && -z "${DATABASE_URL:-}" ]]; then
  echo "ARCHIVE_FOR=$archive_for needs DATABASE_URL, the database whose ledger records it" >&2; exit 2
fi
q() { "${psql_cmd[@]}" "$src_url" -At -v ON_ERROR_STOP=1 -c "$1"; }

db="$(q 'select current_database()')"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${dest_root%/}/$db/$stamp"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
manifest="$work/manifest.tsv"
printf 'table\trows\tbytes\tobject\n' > "$manifest"

put() { # stdin -> $1 under dest
  if [[ "$dest" == gs://* ]]; then gcloud storage cp - "$dest/$1" --quiet
  else mkdir -p "$dest" && cat > "$dest/$1"; fi
}
size_of() {
  if [[ "$dest" == gs://* ]]; then gcloud storage ls -l "$dest/$1" | awk 'NR==1 {print $1}'
  else stat -c %s "$dest/$1"; fi
}

for t in "${tables[@]}"; do
  [[ "$t" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "bad table name: $t" >&2; exit 2; }
  if [[ "$(q "select to_regclass('public.$t') is not null")" != t ]]; then
    printf '%s\tabsent\t\t\n' "$t" >> "$manifest"
    echo "$t: absent, skipped"
    continue
  fi
  rows="$(q "select count(*) from public.\"$t\"")"
  bytes="$(q "select pg_total_relation_size('public.\"$t\"')")"
  "${pg_dump_cmd[@]}" --format=custom --no-owner --no-privileges --table="public.\"$t\"" \
    "$src_url" | put "$t.dump"
  size="$(size_of "$t.dump")"
  [[ -n "$size" && "$size" -gt 0 ]] || { echo "$t: empty archive object" >&2; exit 1; }
  printf '%s\t%s\t%s\t%s\n' "$t" "$rows" "$bytes" "$t.dump" >> "$manifest"
  echo "$t: $rows rows, $size bytes archived"
done

put manifest.tsv < "$manifest"
echo "archived to $dest"

if [[ -n "$archive_for" ]]; then
  # Same table as ARCHIVE_LEDGER_DDL in packages/db/src/migrate.ts.
  PGOPTIONS= "${psql_cmd[@]}" "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -v tag="$archive_for" -v dest="$dest" \
    -v manifest="$(cat "$manifest")" <<'SQL'
set client_min_messages = warning;
create schema if not exists drizzle;
create table if not exists drizzle.contract_archive (
  migration text primary key,
  archived_at timestamptz not null default now(),
  destination text not null,
  manifest text not null
);
insert into drizzle.contract_archive (migration, destination, manifest)
  values (:'tag', :'dest', :'manifest')
  on conflict (migration) do update set archived_at = now(),
    destination = excluded.destination, manifest = excluded.manifest;
SQL
  echo "recorded the archive for $archive_for in drizzle.contract_archive"
fi
