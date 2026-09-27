#!/usr/bin/env bash
# Proves the migration chain rebuilds the database it claims to describe.
# Applies a schema-only dump and every file in migrations/ (in order) to two empty
# databases, fingerprints both with catalog.sql, and fails on any difference,
# index names and guard triggers included.
#   SOURCE_SQL=schema.sql DATABASE_ADMIN_URL=postgres://user:pass@host:5432/postgres scripts/schema-roundtrip.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${SOURCE_SQL:?schema-only dump of the database to compare against}"
: "${DATABASE_ADMIN_URL:?superuser URL on a scratch Postgres with pgvector}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
base="${DATABASE_ADMIN_URL%/*}"

for db in rt_source rt_chain; do
  psql "$DATABASE_ADMIN_URL" -qc "drop database if exists $db" -c "create database $db"
done
# The dump carries extension-owned objects (pg_stat_statements) we do not migrate.
grep -v -E 'pg_stat_statements' "$SOURCE_SQL" | psql "$base/rt_source" -q -v ON_ERROR_STOP=1 >/dev/null

for f in "$here"/../migrations/*.sql; do
  sed 's/--> statement-breakpoint//' "$f" | psql "$base/rt_chain" -q -v ON_ERROR_STOP=1 >/dev/null
done

psql "$base/rt_source" -At -F '|' -f "$here/catalog.sql" > "$work/source.txt"
psql "$base/rt_chain" -At -F '|' -f "$here/catalog.sql" > "$work/chain.txt"
if ! diff -u "$work/source.txt" "$work/chain.txt" > "$work/diff.txt"; then
  grep '^[-+][a-z]' "$work/diff.txt" | cut -d'|' -f1 | sort | uniq -c
  cat "$work/diff.txt"
  exit 1
fi
echo "schema round-trip identical: $(wc -l < "$work/source.txt") objects"
