# Shared by up.sh, doctor.sh and down.sh. Sourced, not run.
ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
PLATFORM=$ROOT/dembrane/platform
FRONTEND=$ROOT/dembrane/frontend
RUNS=$PLATFORM/.data/verify

# The run to act on: $VERIFY_RUN, else the newest one under $RUNS.
pick_run() {
  local run=${VERIFY_RUN:-}
  [ -n "$run" ] || run=$(ls -1t "$RUNS" 2>/dev/null | head -1)
  [ -n "$run" ] && [ -f "$RUNS/$run/env" ] || { echo "no verify run found under $RUNS" >&2; return 1; }
  # shellcheck disable=SC1090
  . "$RUNS/$run/env"
}

listener_pid() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
