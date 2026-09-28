#!/usr/bin/env bash
# The archive the contract migration (0012_contract_dead_features) waits for, split so its
# 21 GB never sits inside the downtime window.
#
#   ops/archive.sh pre             before the window: dumps every table 0012 drops from the
#                                  old database (read-only) to ARCHIVE_DEST. Prints the prefix.
#   ops/archive.sh record <prefix> in the window, after the restore: recounts those tables on
#                                  the frozen old database, checks the manifest matches row for
#                                  row, then records the archive in the new database's ledger
#                                  so the migrate job lets 0012 run.
#
# SOURCE_URL    the old database (read-only).
# TARGET_URL    the new database as its owner (record only).
# ARCHIVE_DEST  gs:// prefix (default gs://dembrane-echo-archive).
#
# The tables have had no writer since the old library and LightRAG were retired, so a count
# that moved between `pre` and `record` means something still writes them: `record` refuses,
# and the fix is to run `pre` again inside the window for the tables it names.
source "$(dirname "$0")/lib.sh"
: "${SOURCE_URL:?}"
here="$OPS_DIR/../packages/db/scripts"
dest="${ARCHIVE_DEST:-gs://dembrane-echo-archive}"
tag=0012_contract_dead_features

pgcmd() { # the archive script takes whole commands
  if command -v "$1" >/dev/null 2>&1 && [[ "$("$1" --version | grep -oE '[0-9]+' | head -1)" -ge 16 ]]; then
    echo "$1"
  else echo "docker run --rm -i --network host -e PGOPTIONS -e PGTZ $PG_IMAGE $1"; fi
}

case "${1:-}" in
  pre)
    out="$(mktemp)"
    # Named tables and no ARCHIVE_FOR: the script only reads and uploads, it records nothing.
    timed archive-pre env -u DATABASE_URL -u ARCHIVE_FOR SOURCE_DATABASE_URL="$SOURCE_URL" \
      ARCHIVE_DEST="$dest" PG_DUMP="$(pgcmd pg_dump)" PSQL="$(pgcmd psql)" \
      "$here/archive-tables.sh" "${CONTRACT_TABLES[@]}" | tee "$out"
    prefix="$(sed -n 's/^archived to //p' "$out")"; rm -f "$out"
    echo "ARCHIVE_PREFIX=$prefix"
    ;;
  record)
    prefix="${2:?archive prefix printed by pre}"
    : "${TARGET_URL:?}"
    refuse_old_stack "$TARGET_URL" "the archive ledger"
    manifest="$(gcloud storage cat "$prefix/manifest.tsv")"
    bad=0
    for t in "${CONTRACT_TABLES[@]}"; do
      line="$(awk -F'\t' -v t="$t" '$1==t' <<<"$manifest")"
      [[ -n "$line" ]] || { log "$t: missing from the manifest"; bad=1; continue; }
      archived="$(cut -f2 <<<"$line")"
      exists="$(psql_src -c "select to_regclass('public.\"$t\"') is not null")"
      if [[ "$exists" != t ]]; then
        [[ "$archived" == absent ]] || { log "$t: archived $archived rows but gone from the source"; bad=1; }
        continue
      fi
      now="$(psql_src -c "select count(*) from public.\"$t\"")"
      if [[ "$now" != "$archived" ]]; then log "$t: archived $archived rows, source has $now now"; bad=1
      else log "$t: $now rows, matches"; fi
    done
    [[ "$bad" == 0 ]] || die "the archive does not match the frozen source; run 'ops/archive.sh pre' again"
    cd "$OPS_DIR/../packages/db"
    timed archive-record env TARGET_URL="$TARGET_URL" ARCHIVE_TAG="$tag" ARCHIVE_PREFIX="$prefix" \
      ARCHIVE_MANIFEST="$manifest" bun -e '
        import { recordContractArchive } from "./src/migrate";
        await recordContractArchive(process.env.TARGET_URL, {
          migration: process.env.ARCHIVE_TAG,
          destination: process.env.ARCHIVE_PREFIX,
          manifest: process.env.ARCHIVE_MANIFEST,
        });'
    log "recorded $prefix for $tag"
    ;;
  *) sed -n '2,21p' "$0"; exit 2 ;;
esac
