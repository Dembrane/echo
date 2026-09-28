#!/usr/bin/env bash
# Copies the old stack's files (DO Spaces: audio, uploads, avatars) into the new bucket with
# Storage Transfer Service. One job per environment, created once and run again for every
# pass: the first run copies everything, later runs copy only what is new or changed, so the
# pass inside the window is a small delta. Keys are kept as they are: rows store audio as
# "<endpoint>/<bucket>/<key>" and the platform reads the key back from any endpoint.
#
#   ops/files-sync.sh create   create the job (no-op when it exists)
#   ops/files-sync.sh run      start a pass and wait for it; prints the counters
#   ops/files-sync.sh status   the latest pass's counters
#
# PROJECT       GCP project (default dembrane-web-prod)
# JOB           job name, e.g. transferJobs/echo-cutover-prod
# SOURCE_BUCKET Spaces bucket, e.g. dbr-echo-prod-uploads
# SINK_BUCKET   GCS bucket, e.g. dembrane-web-prod-echo-prod-uploads
# AGENT_POOL    agent pool whose agents hold the Spaces keys (S3-compatible sources need agents)
# SOURCE_ENDPOINT  default ams3.digitaloceanspaces.com
# INCLUDE_PREFIXES comma-separated key prefixes, for a partial copy (rehearsal samples)
# EXCLUDE_PREFIXES comma-separated key prefixes to leave behind. Prod: conversation_id/ (8.65 TiB
#               of 2025 segment audio for the old library; no kept row references it, it goes
#               with conversation_segment, which the contract migration drops).
# MANIFEST      gs:// CSV of keys (ops/files-manifest.sh): the job copies only those. Use a
#               separate JOB for manifest passes; each run points the job at the manifest given.
#
# The source is only ever read: the job never deletes from the source, and this script has no
# option that would. Objects deleted on Spaces after a pass stay in the sink; nothing reads them.
source "$(dirname "$0")/lib.sh"

PROJECT="${PROJECT:-dembrane-web-prod}"
: "${JOB:?}" "${SOURCE_BUCKET:?}" "${SINK_BUCKET:?}" "${AGENT_POOL:?}"
SOURCE_ENDPOINT="${SOURCE_ENDPOINT:-ams3.digitaloceanspaces.com}"
refuse_old_stack "$SINK_BUCKET" "files"
[[ "$SINK_BUCKET" != *digitalocean* && "$SINK_BUCKET" != dbr-echo-* ]] || die "sink $SINK_BUCKET looks like a Spaces bucket"
g() { gcloud --project "$PROJECT" "$@"; }

exists() { g transfer jobs describe "$JOB" --format='value(name)' >/dev/null 2>&1; }

create() {
  if exists; then log "$JOB exists"; return; fi
  local extra=()
  [[ -n "${INCLUDE_PREFIXES:-}" ]] && extra+=(--include-prefixes="$INCLUDE_PREFIXES")
  [[ -n "${EXCLUDE_PREFIXES:-}" ]] && extra+=(--exclude-prefixes="$EXCLUDE_PREFIXES")
  [[ -n "${MANIFEST:-}" ]] && extra+=(--manifest-file="$MANIFEST")
  # overwrite-when=different compares size and ETag/MD5; unchanged objects are skipped, so
  # a repeated run is cheap. No --delete-from: neither side is ever pruned by the job.
  g transfer jobs create "s3://$SOURCE_BUCKET" "gs://$SINK_BUCKET" \
    --name="$JOB" --description="echo cutover: $SOURCE_BUCKET to $SINK_BUCKET" \
    --source-agent-pool="$AGENT_POOL" --source-endpoint="$SOURCE_ENDPOINT" \
    --source-signing-region=us-east-1 --source-auth-method=AWS_SIGNATURE_V4 \
    --source-request-model=VIRTUAL_HOSTED_STYLE --source-network-protocol=HTTPS \
    --source-list-api=LIST_OBJECTS_V2 --overwrite-when=different \
    --do-not-run "${extra[@]}" --format='value(name)'
}

latest_op() {
  g transfer operations list --job-names="$JOB" --limit=1 --format='value(name)' 2>/dev/null | head -1
}

counters() { # <operation>
  g transfer operations describe "$1" --format=json | python3 -c '
import json, sys
m = json.load(sys.stdin).get("metadata", {})
c = m.get("counters", {})
keys = ["objectsFoundFromSource", "bytesFoundFromSource", "objectsCopiedToSink", "bytesCopiedToSink",
        "objectsFromSourceSkippedBySync", "bytesFromSourceSkippedBySync", "objectsFromSourceFailed"]
print(m.get("status", "?"), m.get("startTime", ""), m.get("endTime", ""),
      " ".join(f"{k}={c.get(k, 0)}" for k in keys))
for e in (m.get("errorBreakdowns") or [])[:5]:
    print("error", e.get("errorCode"), e.get("errorCount"), (e.get("errorLogEntries") or [{}])[0].get("url", ""))'
}

run() {
  if ! exists; then create
  elif [[ -n "${MANIFEST:-}" ]]; then
    g transfer jobs update "$JOB" --manifest-file="$MANIFEST" >/dev/null
  fi
  local before; before="$(latest_op)"
  g transfer jobs run "$JOB" --no-async >/dev/null 2>&1 &
  local runner=$!
  local op=""
  for _ in $(seq 60); do
    op="$(latest_op)"; [[ -n "$op" && "$op" != "$before" ]] && break; sleep 5
  done
  [[ -n "$op" && "$op" != "$before" ]] || die "no new operation for $JOB"
  log "operation $op"
  while :; do
    local line; line="$(counters "$op" | head -1)"
    log "$line"
    case "$line" in
      SUCCESS*) break ;;
      FAILED* | ABORTED*) counters "$op"; die "transfer $line" ;;
    esac
    sleep 20
  done
  wait "$runner" 2>/dev/null || true
  counters "$op"
}

case "${1:-}" in
  create) create ;;
  run) timed "${STEP:-files-sync}" run ;;
  status) op="$(latest_op)"; [[ -n "$op" ]] && counters "$op" ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
