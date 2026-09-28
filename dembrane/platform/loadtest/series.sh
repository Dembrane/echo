#!/usr/bin/env bash
# Three runs per stack and scenario under one budget, interleaved so background load
# hits both stacks alike. Results land in loadtest/results/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
budget=${1:-A}
for scenario in dashboard writes; do
  vus=$([ "$scenario" = dashboard ] && echo 50 || echo 10)
  for i in 1 2 3; do
    for stack in old new; do "$here/run.sh" $stack $scenario $budget $vus 60s >/dev/null || echo "run failed: $stack $scenario $i" >&2; done
  done
done
