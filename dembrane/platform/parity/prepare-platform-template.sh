#!/usr/bin/env bash
# Builds parity_template_platform: the seeded template plus the platform's migrations and
# identities synced from Directus. Both APIs run on copies of it, so each scenario starts
# from one state; the Python API ignores the added auth tables.
# PARITY_TEMPLATE names a private template, so a branch whose migrations differ from
# feat/bun-migration's leaves the shared one alone; tests and the runner read the same name.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tpl="${PARITY_TEMPLATE:-parity_template_platform}"
[[ "$tpl" =~ ^parity_template_[a-z0-9_]+$ ]] || { echo "bad template name: $tpl" >&2; exit 2; }
psql_() { docker exec -i parity-db-1 psql -U dembrane -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
# A template cannot be dropped; unmark it first so the script can run again.
psql_ -c "update pg_database set datistemplate = false where datname = '$tpl'"
psql_ -c "drop database if exists $tpl with (force)"
psql_ -c "create database $tpl template parity_template"
url=postgres://dembrane:dembrane@localhost:5440/$tpl
cd "$here/.."
# The Python API reads the tables contract migrations drop, so they are held back here.
MIGRATE_HOLD_CONTRACT=1 MIGRATION_DATABASE_URL=$url bun apps/migrate/src/main.ts >/dev/null
psql_ -c "update pg_database set datistemplate = true where datname = '$tpl'"
echo "$tpl ready"
