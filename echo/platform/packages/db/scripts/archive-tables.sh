#!/usr/bin/env bash
# Copies tables to cold storage before a contract migration drops them. Runs once at
# cutover, against the database about to be migrated, before the migration job; the
# migration header names the tables. Reads only: pg_dump and count(*), no writes.
#
# One custom-format dump per table (restore with pg_restore -t), plus manifest.tsv with
# each table's exact row count and size at dump time. A table that does not exist is
# recorded as absent and skipped, since some (lightrag_*) exist on prod only.
#
#   DATABASE_URL=postgres://... packages/db/scripts/archive-tables.sh            the default set
#   DATABASE_URL=postgres://... packages/db/scripts/archive-tables.sh view aspect  named tables
#
# ARCHIVE_DEST  gs:// prefix or a local directory (default gs://dembrane-echo-archive).
#               Objects land under <dest>/<database>/<UTC stamp>/.
# PG_DUMP, PSQL override the binaries, e.g. "docker exec -i parity-db-1 pg_dump" for a
#               local run. pg_dump must be at least the server's major version.
set -euo pipefail

: "${DATABASE_URL:?URL of the database to archive from}"
dest_root="${ARCHIVE_DEST:-gs://dembrane-echo-archive}"
pg_dump_cmd=(${PG_DUMP:-pg_dump})
psql_cmd=(${PSQL:-psql})

# The contract migration 0009_contract_dead_features drops these.
default_tables=(
  view aspect aspect_segment insight project_analysis_run
  conversation_segment conversation_segment_conversation_chunk
  lightrag_chunk_graph_map lightrag_doc_chunks lightrag_doc_full lightrag_doc_status
  lightrag_llm_cache lightrag_vdb_entity lightrag_vdb_relation lightrag_vdb_transcript
  workspace_request
)
tables=("$@")
[[ ${#tables[@]} -gt 0 ]] || tables=("${default_tables[@]}")

q() { "${psql_cmd[@]}" "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }

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
    "$DATABASE_URL" | put "$t.dump"
  size="$(size_of "$t.dump")"
  [[ -n "$size" && "$size" -gt 0 ]] || { echo "$t: empty archive object" >&2; exit 1; }
  printf '%s\t%s\t%s\t%s\n' "$t" "$rows" "$bytes" "$t.dump" >> "$manifest"
  echo "$t: $rows rows, $size bytes archived"
done

put manifest.tsv < "$manifest"
echo "archived to $dest"
