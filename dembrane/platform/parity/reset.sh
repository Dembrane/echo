#!/usr/bin/env bash
# Recreates a database from parity_template (a file-level copy, so it takes milliseconds)
# and empties Valkey, so a scenario starts from exactly the seeded state. Directus and the
# API reconnect on their next query.
#   parity/reset.sh [dbname]     default: dembrane, the database Directus and the API use
#   TEMPLATE=parity_template_platform parity/reset.sh   start from the template with the platform schema
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
db="${1:-dembrane}"
[[ "$db" =~ ^[a-z_][a-z0-9_]*$ && "$db" != parity_template && "$db" != postgres ]] || { echo "bad database name: $db" >&2; exit 2; }
docker exec -i parity-db-1 psql -U dembrane -d postgres -v ON_ERROR_STOP=1 -q >/dev/null <<SQL
select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid();
drop database if exists $db with (force);
create database $db template ${TEMPLATE:-parity_template};
SQL
docker exec parity-valkey-1 valkey-cli flushall >/dev/null
