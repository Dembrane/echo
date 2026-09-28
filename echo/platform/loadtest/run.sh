#!/usr/bin/env bash
# Runs one k6 scenario against one stack under a fixed resource budget, on the parity
# database reset from its template, and writes a result JSON. Holds the parity lock so
# no parity run resets the database mid-test.
#   loadtest/run.sh <old|new> <dashboard|writes> <A|B> [vus] [duration]
# Budget A: the app tier gets 2 vCPU and 2 GiB in total (old: API 1.5 vCPU/1.5 GiB plus
# Directus 0.5/0.5, since Directus is in its data path). Budget B, generous to the old
# stack: old API 2 vCPU/2 GiB plus Directus 1 vCPU/1 GiB on top, as prod gives Directus
# its own pods. The new stack gets 2 vCPU/2 GiB in both. Postgres: 2 vCPU/2 GiB for both.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/.."
stack=$1 scenario=$2 budget=$3 vus=${4:-50} duration=${5:-60s}
set -a; . "$root/parity/.env.parity"; set +a
port=8300; out="$here/results/$(date +%Y%m%dT%H%M%S)-$stack-$scenario-$budget.json"

cleanup() {
  systemctl --user stop "echo-load-$stack.scope" 2>/dev/null || true
  for p in $(ss -ltnp | grep ":$port " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u); do kill "$p" 2>/dev/null || true; done
  # Lift the limits again: 0 CPUs means no limit, and a generous memory cap stands in for none.
  docker update --cpus 0 --memory 16g --memory-swap 16g parity-db-1 parity-directus-1 >/dev/null 2>&1 || true
}
trap cleanup EXIT

exec 9>/tmp/echo-parity.lock; flock 9
# Both stacks start from the same rows; the Python API ignores the platform's extra tables.
TEMPLATE=parity_template_platform "$root/parity/reset.sh" dembrane >/dev/null
docker update --cpus 2 --memory 2g --memory-swap 2g parity-db-1 >/dev/null

if [ "$stack" = old ]; then
  if [ "$budget" = A ]; then api_cpu=150% api_mem=1536M dx_cpu=0.5 dx_mem=512m; else api_cpu=200% api_mem=2G dx_cpu=1 dx_mem=1g; fi
  docker update --cpus $dx_cpu --memory $dx_mem --memory-swap $dx_mem parity-directus-1 >/dev/null
  server="$(cd "$root/../server" && pwd)"
  systemd-run --user --scope --unit "echo-load-old" -p CPUQuota=$api_cpu -p MemoryMax=$api_mem \
    env DIRECTUS_BASE_URL=http://localhost:8065 DATABASE_URL=postgresql+psycopg://dembrane:dembrane@localhost:5440/dembrane \
      REDIS_URL=redis://localhost:6395 API_BASE_URL=http://localhost:$port DISABLE_SENTRY=1 \
      STORAGE_S3_KEY=x STORAGE_S3_SECRET=x STORAGE_S3_BUCKET=x STORAGE_S3_ENDPOINT=http://127.0.0.1:9 \
      bash -c "cd '$server' && exec zsh -lic 'uv run --frozen gunicorn dembrane.main:app --worker-class dembrane.gunicorn_worker.AsyncioUvicornWorker --workers 2 --bind 127.0.0.1:$port --timeout 120 --keep-alive 5 --log-level warning'" \
    >/tmp/echo-load-old.log 2>&1 &
  token=$(curl -s -H 'content-type: application/json' -d "{\"email\":\"alice.parity@example.com\",\"password\":\"$PARITY_USER_PASSWORD\"}" http://localhost:8065/auth/login | jq -r .data.access_token)
else
  systemd-run --user --scope --unit "echo-load-new" -p CPUQuota=200% -p MemoryMax=2G \
    env APP_ENV=local PORT=$port DATABASE_URL=postgres://dembrane:dembrane@localhost:5440/dembrane \
      AUTH_SECRET=parity-secret-parity-secret-parity-secret-00 INVITE_HASH_SECRET="$DIRECTUS_SECRET" LOG_LEVEL=warn \
      bash -c "cd '$root' && (bun apps/api/src/main.ts & bun apps/api/src/main.ts & wait)" \
    >/tmp/echo-load-new.log 2>&1 &
fi

for i in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' localhost:$port/api/v2/me || true); [ "$code" = 401 ] && break; sleep 0.5; done
[ "$stack" = new ] && token=$(curl -s -D - -o /dev/null -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d "{\"email\":\"alice.parity@example.com\",\"password\":\"$PARITY_USER_PASSWORD\"}" localhost:$port/api/auth/sign-in/email | awk -F': ' 'tolower($1)=="set-auth-token"{print $2}' | tr -d '\r')
[ -n "$token" ] || { echo "no token for $stack" >&2; exit 1; }

# Warm up so neither side is measured on its first requests.
docker run --rm --user "$(id -u):$(id -g)" --network host -e BASE_URL=http://127.0.0.1:$port -e TOKEN="$token" -e VUS=5 -e DURATION=10s \
  -v "$here/scenarios:/s:ro" grafana/k6 run -q /s/$scenario.js >/dev/null 2>&1 || true

docker run --rm --user "$(id -u):$(id -g)" --network host -e BASE_URL=http://127.0.0.1:$port -e TOKEN="$token" -e VUS=$vus -e DURATION=$duration \
  -v "$here/scenarios:/s:ro" -v "$here/results:/r" grafana/k6 run -q --summary-export /r/k6-summary.json /s/$scenario.js >/dev/null 2>&1 || true

peak=$(systemctl --user show "echo-load-$stack.scope" -p MemoryPeak --value 2>/dev/null || echo 0)
cpu=$(systemctl --user show "echo-load-$stack.scope" -p CPUUsageNSec --value 2>/dev/null || echo 0)
dx_peak=$( [ "$stack" = old ] && docker stats --no-stream --format '{{.MemUsage}}' parity-directus-1 | cut -d/ -f1 || echo "-")
load=$(cut -d' ' -f1 /proc/loadavg)
jq -n --slurpfile s "$here/results/k6-summary.json" --arg stack "$stack" --arg scenario "$scenario" --arg budget "$budget" \
  --arg vus "$vus" --arg duration "$duration" --arg peak "$peak" --arg cpu "$cpu" --arg dx "$dx_peak" --arg load "$load" \
  '{stack:$stack, scenario:$scenario, budget:$budget, vus:($vus|tonumber), duration:$duration,
    rps: $s[0].metrics.http_reqs.rate, requests: $s[0].metrics.http_reqs.count,
    failed_rate: $s[0].metrics.http_req_failed.value,
    p50_ms: $s[0].metrics.http_req_duration["p(50)"], p95_ms: $s[0].metrics.http_req_duration["p(95)"],
    p99_ms: $s[0].metrics.http_req_duration["p(99)"], max_ms: $s[0].metrics.http_req_duration.max,
    api_peak_memory_bytes: ($peak|tonumber? // 0), api_cpu_seconds: (($cpu|tonumber? // 0)/1e9),
    directus_memory: $dx, host_load_1m: ($load|tonumber)}' > "$out"
cat "$out"
