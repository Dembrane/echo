#!/usr/bin/env bash
# Runs parity scenarios while holding the stack-wide lock: the old API reads through the
# one Directus, so only one runner may reset the database at a time. Porting, tests and
# type checks run in parallel; parity runs queue here.
#   PARITY_NEW_URL=http://127.0.0.1:8201 parity/run.sh [filter]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$here/.env.parity"; set +a
old="${PARITY_OLD_URL:-http://127.0.0.1:8100}"
code=$(curl -s -o /dev/null -w '%{http_code}' "$old/api/v2/me" || true)
[[ "$code" == 401 ]] || { echo "old API not answering on $old (got '$code'); start parity/run-old-api.sh" >&2; exit 2; }
exec flock --timeout 1800 /tmp/echo-parity.lock bun "$here/runner/run.ts" "$@"
