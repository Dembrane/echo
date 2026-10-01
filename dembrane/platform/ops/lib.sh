# Shared by the cutover scripts. Source it; do not run it.
#
# The one rule every script here keeps: the old stack (DigitalOcean Postgres and Spaces) is
# read from, never written to. Every connection to it carries default_transaction_read_only,
# and any write path calls refuse_old_stack on its target first.

set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# pg_dump must be at least the server's major version (16 on both sides). Local binaries are
# used when they are 16 or newer, else the same image the platform's compose file runs.
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:0.8.1-pg16}"
TIMINGS="${TIMINGS:-${OPS_DIR}/.timings.tsv}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

# Hosts that belong to the old stack. Writes to them are refused, whatever the flags say.
is_old_stack() {
  [[ "$1" == *".db.ondigitalocean.com"* || "$1" == *"digitaloceanspaces.com"* ]]
}
refuse_old_stack() { # <url or host> <what>
  if is_old_stack "$1"; then die "refusing to write $2 to the old stack ($(redact "$1"))"; fi
}

# A URL with its password removed, safe to print.
redact() { sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#' <<<"$1"; }

# Runs a Postgres client binary: the local one when it is new enough, else in a container on
# the host network with the working directory mounted, so dump directories are shared.
pgbin() { # <binary> args...
  local bin="$1"; shift
  if command -v "$bin" >/dev/null 2>&1 && [[ "$("$bin" --version | grep -oE '[0-9]+' | head -1)" -ge 16 ]]; then
    "$bin" "$@"
  else
    local mounts=(-v "$PWD:$PWD" -w "$PWD")
    [[ -n "${DUMP_DIR:-}" ]] && mounts+=(-v "$(dirname "$DUMP_DIR"):$(dirname "$DUMP_DIR")")
    docker run --rm -i --network host "${mounts[@]}" -e PGOPTIONS -e PGTZ -u "$(id -u):$(id -g)" \
      "$PG_IMAGE" "$bin" "$@"
  fi
}

# Every session against the source is read-only and in UTC, so row text compares across servers.
source_env() { export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=0" PGTZ=UTC; }
target_env() { export PGOPTIONS="-c statement_timeout=0" PGTZ=UTC; }

psql_src() { (source_env; pgbin psql "$SOURCE_URL" -X -At -v ON_ERROR_STOP=1 "$@"); }
psql_tgt() { refuse_old_stack "$TARGET_URL" "SQL"; (target_env; pgbin psql "$TARGET_URL" -X -At -v ON_ERROR_STOP=1 "$@"); }

# Appends one line per step to $TIMINGS: step, start, end, seconds. The runbook's timings
# come from this file.
timed() { # <step name> command...
  local step="$1"; shift
  local t0 t1; t0=$(date +%s)
  log "start $step"
  "$@"
  t1=$(date +%s)
  printf '%s\t%s\t%s\t%s\n' "$step" "$(date -u -d "@$t0" +%FT%TZ)" "$(date -u -d "@$t1" +%FT%TZ)" "$((t1 - t0))" >> "$TIMINGS"
  log "done $step in $((t1 - t0))s"
}

# Tables whose data stays behind in the window. Their schema is restored (empty), so every
# foreign key and the migration chain still line up.
#   directus_revisions, directus_activity  19 GB of Directus audit history; nothing in the new
#       stack reads it. The frozen DO database keeps it, and a copy is archived before
#       DigitalOcean is shut down (runbook step 9).
#   lightrag_*, conversation_segment*, aspect_segment  21 GB the contract migration drops.
#       Archived from the source before the window (archive.sh) and recorded for the guard.
# aspect_segment references conversation_segment, so it goes with it. project_analysis_run
# stays in: processing_status references it and it is 398 rows.
DEFAULT_EXCLUDE_DATA=(
  directus_revisions directus_activity
  conversation_segment conversation_segment_conversation_chunk aspect_segment
  lightrag_chunk_graph_map lightrag_doc_chunks lightrag_doc_full lightrag_doc_status
  lightrag_llm_cache lightrag_vdb_entity lightrag_vdb_relation lightrag_vdb_transcript
)
# The tables 0012_contract_dead_features drops (same list as archive-tables.sh).
CONTRACT_TABLES=(
  view aspect aspect_segment insight project_analysis_run
  conversation_segment conversation_segment_conversation_chunk
  lightrag_chunk_graph_map lightrag_doc_chunks lightrag_doc_full lightrag_doc_status
  lightrag_llm_cache lightrag_vdb_entity lightrag_vdb_relation lightrag_vdb_transcript
  workspace_request
)
exclude_data() { # prints the effective list; EXCLUDE_DATA="" copies everything
  if [[ -v EXCLUDE_DATA ]]; then tr ' ' '\n' <<<"$EXCLUDE_DATA" | sed '/^$/d'
  else printf '%s\n' "${DEFAULT_EXCLUDE_DATA[@]}"; fi
}
