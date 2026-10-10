#!/usr/bin/env bash
# Builds the databases the parity suites copy, from parity_template.sql instead of the old
# stack: parity_template, parity_template_platform (this checkout's migrations on top, as
# ../prepare-platform-template.sh does) and parity_auth, the plain copy the auth suite signs
# in to. For a server that has none of them yet; the server checks run it on every change.
#   DB_CONTAINER=<postgres container> legacy/parity/fixture/load.sh postgres://echo:echo@localhost:5432/postgres
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
admin="${1:?the server admin URL}"
container="${DB_CONTAINER:?the container the server runs in}"
user="$(sed -E 's|^[a-z]+://([^:@/]+).*|\1|' <<<"$admin")"
psql_() { docker exec -i "$container" psql -U "$user" -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -d postgres -c "create database parity_template"
psql_ -d parity_template < "$here/parity_template.sql" >/dev/null
psql_ -d postgres -c "create database parity_auth template parity_template" \
  -c "create database parity_template_platform template parity_template"
cd "$here/../../.."
MIGRATE_HOLD_CONTRACT=1 MIGRATION_DATABASE_URL="${admin%/*}/parity_template_platform" \
  bun apps/migrate/src/main.ts >/dev/null
psql_ -d postgres -c "update pg_database set datistemplate = true where datname = 'parity_template_platform'"
echo "parity_template_platform ready"
