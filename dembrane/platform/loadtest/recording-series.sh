#!/usr/bin/env bash
# Steps one stack's participant count up under one budget until the API side struggles
# (see recording-summary.py), then runs the midpoint between the last good and first bad
# step. Results land in loadtest/results/ as <stamp>-<stack>-recording-<budget>-<vus>*.json.
#   loadtest/recording-series.sh <old|new> <A|B> [steps...]
# STREAM and CHUNK_CONCURRENCY pass through to run.sh.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
stack=$1 budget=$2; shift 2
steps=("${@:-25 50 100 200 400 800 1200 1600}"); steps=(${steps[@]})
export DRAIN_MAX_S=${DRAIN_MAX_S:-120}
good=0 bad=0
run() {
  local out; out=$("$here/run.sh" "$stack" recording "$budget" "$1" 5m 2>/dev/null | sed -n '/^{/,$p')
  if [ -z "$out" ]; then echo "$stack $budget $1: no result" >&2; return 2; fi
  jq -r '"\(.stack) \(.budget) \(.participants): api_sustained=\(.api_sustained) sustained=\(.sustained) ping_fail=\(.ping.fail_rate) ping_p95=\(.ping.p95_ms) reg_p95=\(.chunks.registration_p95_ms) lag_p95=\(.transcription.lag_p95_s) backlog_end=\(.transcription.backlog_at_end) api_cpu=\(.api.cpu_mean_pct) db=\(.db.connections_peak) \(.struggling|join("; "))"' <<<"$out" >&2
  [ "$(jq -r .api_sustained <<<"$out")" = true ]
}
for n in "${steps[@]}"; do
  if run "$n"; then good=$n; else bad=$n; break; fi
done
if [ "$bad" -gt 0 ] && [ "$good" -gt 0 ]; then
  mid=$(( (good + bad) / 2 ))
  [ "$mid" -gt "$good" ] && [ "$mid" -lt "$bad" ] && run "$mid"
fi
exit 0
