#!/usr/bin/env bash
# Proves the Drizzle schema can rebuild the database it describes.
# Applies a source schema dump and the SQL Drizzle generates from src to two empty
# databases, fingerprints both with catalog.sql, and fails on any difference.
#   SOURCE_SQL=path/to/schema.sql DATABASE_ADMIN_URL=postgres://.../postgres scripts/schema-roundtrip.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${SOURCE_SQL:?schema-only dump of the database to compare against}"
: "${DATABASE_ADMIN_URL:?superuser URL on a scratch Postgres with pgvector}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
base="${DATABASE_ADMIN_URL%/*}"

for db in rt_source rt_drizzle; do
  psql "$DATABASE_ADMIN_URL" -qc "drop database if exists $db" -c "create database $db"
done
psql "$base/rt_source" -q -v ON_ERROR_STOP=1 -f "$SOURCE_SQL" >/dev/null

ROUNDTRIP_OUT="$work/out" bunx drizzle-kit generate --config "$here/../drizzle.roundtrip.config.ts" </dev/null >/dev/null
psql "$base/rt_drizzle" -qc "create extension if not exists vector"
for f in "$work"/out/*.sql; do
  sed 's/--> statement-breakpoint//' "$f" | psql "$base/rt_drizzle" -q -v ON_ERROR_STOP=1 >/dev/null
done

psql "$base/rt_source" -At -F '|' -f "$here/catalog.sql" > "$work/source.txt"
psql "$base/rt_drizzle" -At -F '|' -f "$here/catalog.sql" > "$work/drizzle.txt"
if ! diff -u "$work/source.txt" "$work/drizzle.txt" > "$work/diff.txt"; then
  grep '^[-+][a-z]' "$work/diff.txt" | cut -d'|' -f1 | sort | uniq -c
  echo "schema round-trip differs; full diff:" && cat "$work/diff.txt"
  exit 1
fi
echo "schema round-trip identical ($(wc -l < "$work/source.txt") objects)"
