#!/usr/bin/env bash
# Runs one k6 scenario against one stack under a fixed resource budget, on the parity
# database reset from its template, and writes a result JSON. Holds the parity lock so
# no parity run resets the database mid-test.
#   loadtest/run.sh <old|new> <dashboard|writes|recording> <A|B> [vus] [duration]
# Budget A: the app tier gets 2 vCPU and 2 GiB in total (old: API 1.5 vCPU/1.5 GiB plus
# Directus 0.5/0.5, since Directus is in its data path). Budget B, generous to the old
# stack: old API 2 vCPU/2 GiB plus Directus 1 vCPU/1 GiB on top, as prod gives Directus
# its own pods. The new stack gets 2 vCPU/2 GiB in both. Postgres: 2 vCPU/2 GiB for both.
#
# recording: [duration] is each participant's session (default 5m). Uploads go to a local
# MinIO (loadtest-minio, :9100) for both stacks, and each stack's worker tier runs in its
# own scope at 2 vCPU/2 GiB with Gemini replaced by a fixed latency (loadtest/fake). The
# worker tier is one prod instance's shape: old = a cpu worker (2 processes, 1 thread) and
# a network worker (1 gevent process, 50 threads); new = one Bun worker. Options by env:
#   STREAM=0                 participants skip the health stream
#   CHUNK_CONCURRENCY=n      new worker only: conversations.chunk concurrency (default 20)
#   WORKER_POOL_MAX=n        new worker only: its database pool (default 10, as prod)
#   MEDIA=external           new worker only: ffmpeg in a separate media service (apps/media,
#                            unbudgeted) instead of in the worker, as in the cloud
#   FAKE_TRANSCRIBE_MS / FAKE_TRANSCRIBE_JITTER_MS   default 8000 / 4000
#   DRAIN_MAX_S              how long to wait for the transcript backlog after k6 (default 600)
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/.."
stack=$1 scenario=$2 budget=$3 vus=${4:-50}
duration=${5:-$([ "$scenario" = recording ] && echo 5m || echo 60s)}
set -a; . "$root/legacy/parity/.env.parity"; set +a
port=8300; stamp=$(date +%Y%m%dT%H%M%S)
tag="$stack-$scenario-$budget$([ "$scenario" = recording ] && echo "-$vus$([ "${STREAM:-1}" = 0 ] && echo -nostream)$([ -n "${CHUNK_CONCURRENCY:-}" ] && echo "-cc$CHUNK_CONCURRENCY")$([ "${MEDIA:-}" = external ] && echo -media)$([ -n "${WORKER_POOL_MAX:-}" ] && echo "-pool$WORKER_POOL_MAX")")"
out="$here/results/$stamp-$tag.json"
mkdir -p "$here/results"
psql_() { docker exec -i parity-db-1 psql -U dembrane -d dembrane -v ON_ERROR_STOP=1 -Atq "$@"; }

cleanup() {
  [ -n "${sampler:-}" ] && kill "$sampler" 2>/dev/null || true
  # Dramatiq's gevent worker ignores SIGTERM past systemd's 90 s stop timeout, and a scope
  # left failed blocks the next run's unit of the same name: kill outright and forget it.
  units=("echo-load-$stack.scope" "echo-load-$stack-worker.scope" "echo-load-$stack-media.scope")
  systemctl --user kill -s KILL "${units[@]}" 2>/dev/null || true
  systemctl --user stop "${units[@]}" 2>/dev/null || true
  systemctl --user reset-failed "${units[@]}" 2>/dev/null || true
  for p in $(ss -ltnp | grep ":$port " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u); do kill "$p" 2>/dev/null || true; done
  # Lift the limits again: docker update keeps a CPU cap it is given 0 for, so the cap goes
  # back to every core, and a generous memory cap stands in for none.
  docker update --cpus "$(nproc)" --memory 16g --memory-swap 16g parity-db-1 parity-directus-1 >/dev/null 2>&1 || true
  # The shared parity stack must outlive a run whose cap killed Directus.
  [ "$(docker inspect -f '{{.State.Running}}' parity-directus-1 2>/dev/null)" = true ] || docker start parity-directus-1 >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$scenario" = recording ]; then
  s3=(STORAGE_S3_KEY=loadtest STORAGE_S3_SECRET=loadtest-secret STORAGE_S3_BUCKET=echo-load
    STORAGE_S3_ENDPOINT=http://127.0.0.1:9100 STORAGE_S3_REGION=us-east-1)
  curl -sf -o /dev/null http://127.0.0.1:9100/minio/health/live || { echo "loadtest-minio is not up on :9100" >&2; exit 1; }
  fixture="$here/.fixtures/chunk-30s.webm"
  if [ ! -f "$fixture" ]; then
    # A 30 s chunk as the portal's MediaRecorder makes it: Opus in WebM, 48 kHz mono.
    mkdir -p "$here/.fixtures"; src="${LOADTEST_AUDIO:-$HOME/server/tools/echo-coreflow/qa-clip-48k.wav}"
    if [ -f "$src" ]; then input=(-stream_loop -1 -i "$src"); else input=(-f lavfi -i "anoisesrc=d=30:c=pink:a=0.3"); fi
    ffmpeg -hide_banner -loglevel error -y "${input[@]}" -t 30 -ac 1 -ar 48000 -c:a libopus -b:a 128k "$fixture"
  fi
else
  # No object store: the same dead endpoint for both, as in the parity stack.
  s3=(STORAGE_S3_KEY=x STORAGE_S3_SECRET=x STORAGE_S3_BUCKET=x STORAGE_S3_ENDPOINT=http://127.0.0.1:9)
fi

exec 9>/tmp/echo-parity.lock; flock 9
systemctl --user reset-failed "echo-load-$stack.scope" "echo-load-$stack-worker.scope" 2>/dev/null || true
# Both stacks start from the same rows; the Python API ignores the platform's extra tables.
TEMPLATE=parity_template_platform "$root/legacy/parity/reset.sh" dembrane >/dev/null
docker update --cpus 2 --memory 2g --memory-swap 2g parity-db-1 >/dev/null

if [ "$scenario" = recording ]; then
  # When each chunk's transcript lands, stamped by the database so both stacks are timed alike.
  psql_ <<'SQL'
create table loadtest_transcript (chunk_id uuid primary key, ts timestamptz, transcribed_at timestamptz);
create function loadtest_mark() returns trigger language plpgsql as $$
begin
  if new.transcript is not null and (tg_op = 'INSERT' or old.transcript is null) then
    insert into loadtest_transcript values (new.id, new."timestamp", clock_timestamp()) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger loadtest_mark after insert or update of transcript on conversation_chunk
  for each row execute function loadtest_mark();
SQL
fi

old_env=(DIRECTUS_BASE_URL=http://localhost:8065 DATABASE_URL=postgresql+psycopg://dembrane:dembrane@localhost:5440/dembrane
  REDIS_URL=redis://localhost:6395 API_BASE_URL=http://localhost:$port DISABLE_SENTRY=1 "${s3[@]}")
new_env=(APP_ENV=local DATABASE_URL=postgres://dembrane:dembrane@localhost:5440/dembrane LOG_LEVEL=warn "${s3[@]}")

if [ "$stack" = old ]; then
  if [ "$budget" = A ]; then api_cpu=150% api_mem=1536M dx_cpu=0.5 dx_mem=512m; else api_cpu=200% api_mem=2G dx_cpu=1 dx_mem=1g; fi
  # A Directus grown past the budget's cap under an earlier run is OOM-killed by the cap:
  # restart it so every old run starts from a fresh Directus.
  docker restart parity-directus-1 >/dev/null
  for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' parity-directus-1)" = healthy ] && break; sleep 2; done
  docker update --cpus $dx_cpu --memory $dx_mem --memory-swap $dx_mem parity-directus-1 >/dev/null
  source "$root/legacy/parity/old-echo.sh"
  server="$OLD_ECHO_DIR/echo/server"
  systemd-run --user --scope --unit "echo-load-old" -p CPUQuota=$api_cpu -p MemoryMax=$api_mem \
    env "${old_env[@]}" \
      bash -c "cd '$server' && exec zsh -lic 'uv run --frozen gunicorn dembrane.main:app --worker-class dembrane.gunicorn_worker.AsyncioUvicornWorker --workers 2 --bind 127.0.0.1:$port --timeout 120 --keep-alive 5 --log-level warning'" \
    >/tmp/echo-load-old.log 2>&1 &
  if [ "$scenario" = recording ]; then
    systemd-run --user --scope --unit "echo-load-old-worker" -p CPUQuota=200% -p MemoryMax=2G \
      env "${old_env[@]}" PYTHONPATH="$here/fake" TRANSCRIPTION_PROVIDER=Dembrane-26-07 \
        GCP_SA_JSON='{"type":"service_account","project_id":"loadtest"}' \
        FAKE_TRANSCRIBE_MS="${FAKE_TRANSCRIBE_MS:-8000}" FAKE_TRANSCRIBE_JITTER_MS="${FAKE_TRANSCRIBE_JITTER_MS:-4000}" \
        bash -c "cd '$server' && { uv run --frozen dramatiq --queues cpu --processes 2 --threads 1 loadtest_fake_tasks &
          dramatiq_prom_port=9192 uv run --frozen dramatiq-gevent --queues network --processes 1 --threads 50 loadtest_fake_tasks & wait; }" \
      >/tmp/echo-load-old-worker.log 2>&1 &
  fi
  token=$(curl -s -H 'content-type: application/json' -d "{\"email\":\"alice.parity@example.com\",\"password\":\"$PARITY_USER_PASSWORD\"}" http://localhost:8065/auth/login | jq -r .data.access_token)
else
  systemd-run --user --scope --unit "echo-load-new" -p CPUQuota=200% -p MemoryMax=2G \
    env "${new_env[@]}" PORT=$port \
      AUTH_SECRET=parity-secret-parity-secret-parity-secret-00 INVITE_HASH_SECRET="$DIRECTUS_SECRET" \
      bash -c "cd '$root' && (bun apps/api/src/main.ts & bun apps/api/src/main.ts & wait)" \
    >/tmp/echo-load-new.log 2>&1 &
  if [ "$scenario" = recording ] && [ "${MEDIA:-}" = external ]; then
    # ffmpeg in its own service outside the worker's budget, as Cloud Run's media service.
    systemd-run --user --scope --unit "echo-load-new-media" env APP_ENV=local PORT=8310 LOG_LEVEL=warn \
      bash -c "cd '$root' && exec bun apps/media/src/main.ts" >/tmp/echo-load-new-media.log 2>&1 &
    new_env+=(MEDIA_URL=http://127.0.0.1:8310)
  fi
  if [ "$scenario" = recording ]; then
    systemd-run --user --scope --unit "echo-load-new-worker" -p CPUQuota=200% -p MemoryMax=2G \
      env "${new_env[@]}" LOADTEST_CHUNK_CONCURRENCY="${CHUNK_CONCURRENCY:-}" ${WORKER_POOL_MAX:+DATABASE_POOL_MAX=$WORKER_POOL_MAX} \
        FAKE_TRANSCRIBE_MS="${FAKE_TRANSCRIBE_MS:-8000}" FAKE_TRANSCRIBE_JITTER_MS="${FAKE_TRANSCRIBE_JITTER_MS:-4000}" \
        bash -c "cd '$root' && exec bun --preload ./loadtest/fake/worker-preload.ts apps/worker/src/main.ts" \
      >/tmp/echo-load-new-worker.log 2>&1 &
  fi
fi

for i in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' localhost:$port/api/v2/me || true); [ "$code" = 401 ] && break; sleep 0.5; done
[ "$stack" = new ] && token=$(curl -s -D - -o /dev/null -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d "{\"email\":\"alice.parity@example.com\",\"password\":\"$PARITY_USER_PASSWORD\"}" localhost:$port/api/auth/sign-in/email | awk -F': ' 'tolower($1)=="set-auth-token"{print $2}' | tr -d '\r')
[ -n "$token" ] || { echo "no token for $stack" >&2; exit 1; }

k6env=(-e BASE_URL=http://127.0.0.1:$port -e TOKEN="$token")
k6vol=(-v "$here/scenarios:/s:ro")
if [ "$scenario" = recording ]; then
  k6env+=(-e STREAM="${STREAM:-1}")
  k6vol+=(-v "$here/.fixtures:/f:ro")
  # The worker tier must be up before participants arrive: its log says so, or chunks just queue.
  for i in $(seq 1 120); do
    if [ "$stack" = new ]; then grep -q "worker started" /tmp/echo-load-new-worker.log 2>/dev/null && break
    else [ "$(grep -c "Worker process is ready" /tmp/echo-load-old-worker.log 2>/dev/null)" -ge 3 ] && break; fi
    sleep 1
  done
  systemctl --user is-active -q "echo-load-$stack-worker.scope" || { echo "the $stack worker did not start" >&2; exit 1; }
fi

# Warm up so neither side is measured on its first requests.
docker run --rm --user "$(id -u):$(id -g)" --network host "${k6env[@]}" -e VUS=5 -e DURATION=10s -e SESSION=35s \
  "${k6vol[@]}" grafana/k6 run -q /s/$scenario.js >/dev/null 2>&1 || true

if [ "$scenario" = recording ]; then
  # The warm-up's chunks are not part of the run.
  psql_ -c "truncate loadtest_transcript"
  samples="$here/results/$stamp-$tag.samples.jsonl"
  wunit="echo-load-$stack-worker.scope"
  db_id=$(docker inspect -f '{{.Id}}' parity-db-1); dx_id=$(docker inspect -f '{{.Id}}' parity-directus-1)
  (
    while :; do
      db=$(psql_ -F ' ' -c "select count(*), count(*) filter (where state <> 'idle')
          from pg_stat_activity where datname = 'dembrane' and pid <> pg_backend_pid()" \
        -c "select count(*) filter (where transcript is null and error is null and \"timestamp\" > now() - interval '1 hour'),
          (select count(*) from loadtest_transcript) from conversation_chunk" | tr '\n' ' ')
      read -r conns busy waiting transcribed <<<"$db"
      prop() { systemctl --user show "$1" -p "$2" --value 2>/dev/null | grep -E '^[0-9]+$' || echo 0; }
      cg() { awk '/^usage_usec/{print $2 * 1000}' "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat" 2>/dev/null || echo 0; }
      printf '{"t":%s,"api_cpu_ns":%s,"api_mem":%s,"worker_cpu_ns":%s,"worker_mem":%s,"db_cpu_ns":%s,"directus_cpu_ns":%s,"db_conns":%s,"db_busy":%s,"waiting":%s,"transcribed":%s}\n' \
        "$(date +%s.%N)" "$(prop "echo-load-$stack.scope" CPUUsageNSec)" "$(prop "echo-load-$stack.scope" MemoryCurrent)" \
        "$(prop "$wunit" CPUUsageNSec)" "$(prop "$wunit" MemoryCurrent)" "$(cg "$db_id")" "$(cg "$dx_id")" \
        "${conns:-0}" "${busy:-0}" "${waiting:-0}" "${transcribed:-0}"
      sleep 5
    done
  ) >"$samples" &
  sampler=$!
  k6env+=(-e VUS=$vus -e SESSION=$duration)
else
  k6env+=(-e VUS=$vus -e DURATION=$duration)
fi

k6_start=$(date +%s.%N)
docker run --rm --user "$(id -u):$(id -g)" --network host "${k6env[@]}" \
  "${k6vol[@]}" -v "$here/results:/r" grafana/k6 run -q --summary-export /r/k6-summary.json /s/$scenario.js \
  >"$here/results/k6.log" 2>&1 || true
k6_end=$(date +%s.%N)

peak=$(systemctl --user show "echo-load-$stack.scope" -p MemoryPeak --value 2>/dev/null || echo 0)
cpu=$(systemctl --user show "echo-load-$stack.scope" -p CPUUsageNSec --value 2>/dev/null || echo 0)
dx_peak=$( [ "$stack" = old ] && docker stats --no-stream --format '{{.MemUsage}}' parity-directus-1 | cut -d/ -f1 || echo "-")
load=$(cut -d' ' -f1 /proc/loadavg)

if [ "$scenario" = recording ]; then
  # Let the worker finish what was uploaded; a backlog that does not drain is itself a result.
  drain_start=$(date +%s)
  while [ $(( $(date +%s) - drain_start )) -lt "${DRAIN_MAX_S:-600}" ]; do
    left=$(psql_ -c "select count(*) from conversation_chunk where transcript is null and error is null")
    [ "$left" = 0 ] && break
    sleep 5
  done
  drain_s=$(( $(date +%s) - drain_start ))
  kill "$sampler" 2>/dev/null || true; sampler=
  lag=$(psql_ -F ' ' -c "select count(*), coalesce(round(extract(epoch from percentile_cont(0.5) within group (order by transcribed_at - ts))::numeric, 1), 0),
      coalesce(round(extract(epoch from percentile_cont(0.95) within group (order by transcribed_at - ts))::numeric, 1), 0)
      from loadtest_transcript where ts >= to_timestamp($k6_start)")
  errs=$(psql_ -c "select count(*) from conversation_chunk where error is not null and \"timestamp\" > now() - interval '1 hour'")
  left=$(psql_ -c "select count(*) from conversation_chunk where transcript is null and error is null")
  # Lag per minute of the session, by upload time: flat is keeping up, rising is falling behind.
  lag_by_minute=$(psql_ -c "select coalesce(json_agg(json_build_object('minute', m, 'chunks', n, 'p95_s', p95) order by m), '[]')
      from (select floor(extract(epoch from ts - to_timestamp($k6_start)) / 60)::int m, count(*) n,
        round(extract(epoch from percentile_cont(0.95) within group (order by transcribed_at - ts))::numeric, 1) p95
        from loadtest_transcript where ts >= to_timestamp($k6_start) group by 1) x")
  python3 "$here/recording-summary.py" "$here/results/k6-summary.json" "$samples" \
    --stack "$stack" --budget "$budget" --vus "$vus" --session "$duration" --stream "${STREAM:-1}" \
    --chunk-concurrency "${CHUNK_CONCURRENCY:-default}" --k6-start "$k6_start" --k6-end "$k6_end" \
    --lag "$lag" --lag-by-minute "$lag_by_minute" --errors "$errs" --left "$left" --drain-s "$drain_s" \
    --api-peak "$peak" --directus "$dx_peak" --load "$load" \
    --worker-peak "$(systemctl --user show "echo-load-$stack-worker.scope" -p MemoryPeak --value 2>/dev/null || echo 0)" \
    --api-log "/tmp/echo-load-$stack.log" --worker-log "/tmp/echo-load-$stack-worker.log" >"$out"
  cat "$out"
  exit 0
fi

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
