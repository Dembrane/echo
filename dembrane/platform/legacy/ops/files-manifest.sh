#!/usr/bin/env bash
# Writes the Storage Transfer manifest for the in-window file delta: every object key a row
# references that was written after SINCE. The new stack reads files only through these rows,
# so copying exactly these keys is what the switch needs; a full listing of Spaces (millions of
# objects, 10+ minutes) runs after the switch instead, while Spaces stays frozen.
#
#   TARGET_URL=postgres://... SINCE=2026-10-03T06:00:00Z \
#   MANIFEST=gs://dembrane-web-prod-echo-archive/manifests/prod-delta.csv legacy/ops/files-manifest.sh
#
# TARGET_URL  the restored new database (read-only here; it holds the same rows as the frozen source)
# SINCE       start time of the last completed full pass, minus a margin (UTC, ISO 8601)
# MANIFEST    gs:// object to write; STS reads it with --manifest-file
#
# Rows store audio as "<endpoint>/<bucket>/<key>"; the key is everything after the bucket,
# without a query string, the same rule the platform's AudioUrls.keyOf applies.
source "$(dirname "$0")/lib.sh"
: "${TARGET_URL:?}" "${SINCE:?}" "${MANIFEST:?}"
[[ "$MANIFEST" == gs://* ]] || die "MANIFEST must be a gs:// object"
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || die "SINCE must look like 2026-10-03T06:00:00Z"

keys="$(mktemp)"; trap 'rm -f "$keys"' EXIT
(export PGOPTIONS="-c default_transaction_read_only=on" PGTZ=UTC
 pgbin psql "$TARGET_URL" -X -At -v ON_ERROR_STOP=1 -v since="$SINCE" <<'SQL'
with refs as (
  select path as ref from conversation_chunk
    where path is not null and greatest(created_at, updated_at, "timestamp") > :'since'::timestamptz
  union
  select merged_audio_path from conversation
    where merged_audio_path is not null and greatest(created_at, updated_at) > :'since'::timestamptz
  union
  select filename_disk from directus_files
    where filename_disk is not null
      and greatest(created_on, modified_on, coalesce(uploaded_on, created_on)) > :'since'::timestamptz
)
select distinct split_part(regexp_replace(ref, '^https?://[^/]+/[^/]+/', ''), '?', 1)
from refs where ref <> '' order by 1;
SQL
) > "$keys"
# CSV: quote a key that holds a comma or a quote.
sed -E '/[",]/ { s/"/""/g; s/^(.*)$/"\1"/ }' "$keys" | gcloud storage cp - "$MANIFEST" --quiet
log "manifest $MANIFEST: $(wc -l < "$keys") keys referenced since $SINCE"
echo "MANIFEST_KEYS=$(wc -l < "$keys")"
