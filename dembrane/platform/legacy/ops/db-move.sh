#!/usr/bin/env bash
# Moves the database from the frozen old stack (DO Postgres) into a Cloud SQL database:
# a parallel pg_dump in directory format, a parallel pg_restore, then ANALYZE.
#
#   SOURCE_URL=postgres://...do...:25060/defaultdb?sslmode=require \
#   TARGET_URL=postgres://echo_owner:...@127.0.0.1:5432/echo \
#   DUMP_DIR=/data/cutover/dump legacy/ops/db-move.sh all
#
# Subcommands: dump, restore, analyze, all (the three in order).
#
# SOURCE_URL  the old database, direct port 25060 (the pgbouncer pool cannot run pg_dump).
#             Opened read-only; nothing here writes to it.
# TARGET_URL  the new database as its owner (echo_owner), through cloud-sql-proxy. Refused
#             when it points at DigitalOcean.
# DUMP_DIR    where the dump lives. A finished dump is reused: rerunning `dump` is a no-op
#             until the directory is removed. Written to DUMP_DIR.partial first.
# JOBS        parallel workers for dump, restore and analyze (default 8). Cloud SQL restores
#             scale with its vCPUs; more jobs than vCPUs only adds contention.
# EXCLUDE_DATA  space-separated tables whose rows stay behind (default in lib.sh). Set it to
#             "" to copy everything.
# RESET_TARGET=1  lets `restore` empty a target that already has tables, so a failed or
#             repeated restore can be run again. Without it a non-empty target is refused.
source "$(dirname "$0")/lib.sh"

JOBS="${JOBS:-8}"
cmd="${1:-}"

dump() {
  : "${SOURCE_URL:?}" "${DUMP_DIR:?}"
  if [[ -f "$DUMP_DIR/toc.dat" ]]; then log "dump exists at $DUMP_DIR, reusing it"; return; fi
  rm -rf "$DUMP_DIR.partial"; mkdir -p "$(dirname "$DUMP_DIR")"
  local args=() t
  while read -r t; do args+=(--exclude-table-data="public.\"$t\""); done < <(exclude_data)
  log "dumping $(redact "$SOURCE_URL") with $JOBS jobs, rows of $(exclude_data | wc -l) tables left behind"
  (source_env; pgbin pg_dump "$SOURCE_URL" --format=directory --jobs="$JOBS" --compress=zstd:1 \
    --no-owner --no-privileges "${args[@]}" --file="$DUMP_DIR.partial")
  mv "$DUMP_DIR.partial" "$DUMP_DIR"
  log "dump: $(du -sh "$DUMP_DIR" | cut -f1)"
}

restore() {
  : "${TARGET_URL:?}" "${DUMP_DIR:?}"
  refuse_old_stack "$TARGET_URL" "a restore"
  [[ -f "$DUMP_DIR/toc.dat" ]] || die "no finished dump at $DUMP_DIR"
  if [[ "$(psql_tgt -c "select to_regclass('public.project') is not null")" == t ]]; then
    [[ "${RESET_TARGET:-}" == 1 ]] || die "target already has tables; set RESET_TARGET=1 to empty it and restore again"
    log "emptying the target (public, drizzle, dbos)"
    psql_tgt -q -c "drop schema if exists drizzle cascade; drop schema if exists dbos cascade;
      drop schema public cascade; create schema public;"
  fi
  # The extensions are created by the owner before the restore. pg_stat_statements and the
  # comments on extensions belong to the server's superuser on Cloud SQL; the restore would
  # fail on them, and neither carries data.
  psql_tgt -q -c "create extension if not exists vector; create extension if not exists pg_stat_statements;"
  local list; list="$(mktemp)"
  pgbin pg_restore --list "$DUMP_DIR" | grep -vE ' (EXTENSION|COMMENT) - (EXTENSION )?(vector|pg_stat_statements|plpgsql)| SCHEMA - public ' > "$list"
  cp "$list" "$DUMP_DIR.restore-list"; rm -f "$list"
  log "restoring into $(redact "$TARGET_URL") with $JOBS jobs"
  (target_env; pgbin pg_restore --dbname="$TARGET_URL" --jobs="$JOBS" --no-owner --no-privileges \
    --exit-on-error --use-list="$DUMP_DIR.restore-list" "$DUMP_DIR")
}

analyze() {
  : "${TARGET_URL:?}"
  refuse_old_stack "$TARGET_URL" "ANALYZE"
  # Fresh tables have no statistics; without them the first queries plan as if every table
  # were empty. Minimal stages first so the planner has numbers within seconds.
  (target_env; pgbin vacuumdb --dbname="$TARGET_URL" --analyze-in-stages --jobs="$JOBS" --schema=public)
}

case "$cmd" in
  dump) timed db-dump dump ;;
  restore) timed db-restore restore ;;
  analyze) timed db-analyze analyze ;;
  all) timed db-dump dump; timed db-restore restore; timed db-analyze analyze ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
