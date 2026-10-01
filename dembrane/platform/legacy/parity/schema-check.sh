#!/usr/bin/env bash
# Compares the parity database's public schema with echo-next's schema-only dump, using
# the same fingerprint as packages/db/scripts/schema-roundtrip.sh. Differences confined to
# Directus system tables are listed but do not fail; anything else fails.
#   REF_SQL=path/to/schema.sql legacy/parity/schema-check.sh [dbname]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="${REF_SQL:-$HOME/server/data/echo-migration/echo-next-schema.sql}"
db="${1:-dembrane}"
catalog="$here/../../packages/db/scripts/catalog.sql"
dc() { docker compose -f "$here/compose.yml" --env-file "$here/.env.parity" "$@"; }
q() { dc exec -T db psql -U dembrane -v ON_ERROR_STOP=1 -q "$@"; }
out="$here/.schema-check"; mkdir -p "$out"

q -d postgres -c "drop database if exists echo_next_ref" -c "create database echo_next_ref"
# Extension-owned objects (pg_stat_statements) are not part of echo's schema.
grep -v -E 'pg_stat_statements' "$ref" | q -d echo_next_ref >/dev/null

# The reference went through pg_dump and a reload, which rewrites how Postgres deparses
# some expressions (IN-lists in CHECKs and partial indexes). Send parity through the same
# trip so only real differences remain.
q -d postgres -c "drop database if exists parity_ref" -c "create database parity_ref"
dc exec -T db pg_dump -U dembrane -s -O -x "$db" | grep -v -E 'pg_stat_statements' | q -d parity_ref >/dev/null

q -d echo_next_ref -At -F '|' < "$catalog" > "$out/echo-next.txt"
q -d parity_ref -At -F '|' < "$catalog" > "$out/parity.txt"
q -d postgres -c "drop database echo_next_ref" -c "drop database parity_ref"

diff "$out/echo-next.txt" "$out/parity.txt" | grep '^[<>]' > "$out/diff.txt" || true
grep -E '^[<>] [a-z]+\|(directus_|"directus_)' "$out/diff.txt" > "$out/diff-directus.txt" || true
grep -v -E '^[<>] [a-z]+\|(directus_|"directus_)' "$out/diff.txt" > "$out/diff-app.txt" || true

echo "fingerprint lines: echo-next $(wc -l < "$out/echo-next.txt"), parity $(wc -l < "$out/parity.txt")"
echo "directus system table differences: $(wc -l < "$out/diff-directus.txt") (< echo-next only, > parity only)"
sed 's/^/  /' "$out/diff-directus.txt"
if [[ -s "$out/diff-app.txt" ]]; then
  echo "APP SCHEMA DIFFERS: $(wc -l < "$out/diff-app.txt") lines (< echo-next only, > parity only)"
  sed 's/^/  /' "$out/diff-app.txt"
  exit 1
fi
echo "app schema identical to echo-next"
