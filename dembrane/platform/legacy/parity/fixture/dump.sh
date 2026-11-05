#!/usr/bin/env bash
# Rewrites parity_template.sql from the parity stack's parity_template (../bootstrap.sh): a
# scratch copy, scrub.sql on it, then a plain dump without owners or grants. The restrict key
# is fixed so a rerun on the same template changes no line.
#   legacy/parity/fixture/dump.sh
#   DB_CONTAINER=other-db-1 DB_USER=echo legacy/parity/fixture/dump.sh   another server holding parity_template
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
container="${DB_CONTAINER:-parity-db-1}"
user="${DB_USER:-dembrane}"
scratch=parity_fixture_scratch
psql_() { docker exec -i "$container" psql -U "$user" -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -d postgres -c "drop database if exists $scratch with (force)"
psql_ -d postgres -c "create database $scratch template parity_template"
psql_ -d "$scratch" < "$here/scrub.sql"
docker exec "$container" pg_dump -U "$user" --no-owner --no-acl --restrict-key=parityfixture "$scratch" > "$here/parity_template.sql"
psql_ -d postgres -c "drop database $scratch"
echo "parity_template.sql: $(wc -c < "$here/parity_template.sql") bytes"
