#!/usr/bin/env bash
# Builds parity_template_platform: the seeded template plus the platform's migrations and
# identities synced from Directus. Both APIs run on copies of it, so each scenario starts
# from one state; the Python API ignores the added auth tables.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
psql_() { docker exec -i parity-db-1 psql -U dembrane -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
# A template cannot be dropped; unmark it first so the script can run again.
psql_ -c "update pg_database set datistemplate = false where datname = 'parity_template_platform'"
psql_ -c "drop database if exists parity_template_platform with (force)"
psql_ -c "create database parity_template_platform template parity_template"
url=postgres://dembrane:dembrane@localhost:5440/parity_template_platform
cd "$here/.."
MIGRATION_DATABASE_URL=$url bun apps/migrate/src/main.ts >/dev/null
psql_ -c "update pg_database set datistemplate = true where datname = 'parity_template_platform'"
echo "parity_template_platform ready"
