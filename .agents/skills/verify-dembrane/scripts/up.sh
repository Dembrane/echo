#!/usr/bin/env bash
# Starts an isolated dembrane instance for verification: its own database, ports and files dir,
# so it never touches a stack the developer runs on 8080/5173/5174, nor another verify run.
# Postgres comes from docker compose when docker is running, otherwise from native Postgres on :5432.
# Prints the run's env file on success; source it for the URLs and paths.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

RUN=${VERIFY_RUN:-v$(date +%Y%m%d%H%M%S)-$(head -c 2 /dev/urandom | od -An -tx1 | tr -d ' \n')}
STATE=$RUNS/$RUN
EVIDENCE=$FRONTEND/test-results/verify-dembrane/$RUN
mkdir "$STATE" 2>/dev/null || { echo "run $RUN already exists at $STATE" >&2; exit 1; }
mkdir -p "$STATE/files" "$EVIDENCE"
trap 'echo "up.sh failed; logs in $STATE. Clean up with: VERIFY_RUN=$RUN $SCRIPTS/down.sh" >&2' ERR

API_PORT=$(claim_port 8180)
DASH_PORT=$(claim_port 5273)
PORTAL_PORT=$(claim_port 5273)

if [ ! -f "$PLATFORM/.env.local" ]; then
  # Same bootstrap as platform/scripts/setup.sh.
  cp "$PLATFORM/.env.example" "$PLATFORM/.env.local"
  echo "AUTH_SECRET=$(head -c 32 /dev/urandom | base64)" >> "$PLATFORM/.env.local"
  echo "INVITE_HASH_SECRET=$(head -c 32 /dev/urandom | base64)" >> "$PLATFORM/.env.local"
fi

if docker info >/dev/null 2>&1; then
  MODE=docker
  DB=echo
  DB_PORT=$(claim_port 5533)
  COMPOSE_PROJECT=echo-verify-$RUN
  (cd "$PLATFORM" && ECHO_DB_PORT=$DB_PORT docker compose -p "$COMPOSE_PROJECT" up -d --wait db) > "$STATE/db.log" 2>&1
else
  MODE=native
  DB=echo_verify_${RUN//-/_}
  DB_PORT=5432
  COMPOSE_PROJECT=
  pg_isready -q -h localhost -p 5432 || {
    echo "docker is not running and no Postgres answers on :5432." >&2
    echo "See 'Run it without docker' in dembrane/platform/README.md." >&2
    false
  }
  PGPASSWORD=echo createdb -h localhost -p 5432 -U echo --owner=echo "$DB"
fi
DB_URL=postgres://echo:echo@localhost:$DB_PORT/$DB
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
PLATFORM_FINGERPRINT=$(platform_fingerprint)

cat > "$STATE/env" <<ENV
RUN=$RUN
MODE=$MODE
STATE=$STATE
EVIDENCE=$EVIDENCE
SESSION=verify-$RUN
COMMIT=$COMMIT
PLATFORM_FINGERPRINT=$PLATFORM_FINGERPRINT
DB=$DB
DB_PORT=$DB_PORT
DB_URL=$DB_URL
COMPOSE_PROJECT=$COMPOSE_PROJECT
API_PORT=$API_PORT
DASH_PORT=$DASH_PORT
PORTAL_PORT=$PORTAL_PORT
API_URL=http://localhost:$API_PORT
DASHBOARD_URL=http://localhost:$DASH_PORT
PORTAL_URL=http://portal.localhost:$PORTAL_PORT
ENV

cat > "$EVIDENCE/proof.md" <<MD
# Verify run $RUN

- Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Code: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $COMMIT, $(git -C "$ROOT" status --porcelain | grep -c . || true) uncommitted paths
- Database: $MODE, \`$DB\` on :$DB_PORT
- Dashboard: http://localhost:$DASH_PORT, portal: http://portal.localhost:$PORTAL_PORT, API: http://localhost:$API_PORT
MD

# Shell env wins over --env-file in bun, so these override .env.local and the local config defaults.
export DATABASE_URL=$DB_URL MIGRATION_DATABASE_URL=$DB_URL PORT=$API_PORT \
  API_PUBLIC_URL=http://localhost:$API_PORT DASHBOARD_URL=http://localhost:$DASH_PORT \
  PORTAL_URL=http://portal.localhost:$PORTAL_PORT FILES_LOCAL_ROOT=$STATE/files \
  AUDIO_LOCAL_ROOT=$STATE/audio

cd "$PLATFORM"
bun --env-file=.env.local packages/db/src/migrate.ts > "$STATE/migrate.log" 2>&1
bun --env-file=.env.local packages/verify/src/seed-cli.ts >> "$STATE/migrate.log" 2>&1
nohup bun --env-file=.env.local apps/api/src/main.ts > "$STATE/api.log" 2>&1 &
echo $! > "$STATE/api.pid"
nohup bun --env-file=.env.local apps/worker/src/main.ts > "$STATE/worker.log" 2>&1 &
echo $! > "$STATE/worker.pid"

# The portal router is picked by a hostname starting with "portal." (src/config.ts), since
# only port 5174 also picks it, so the portal is served as portal.localhost.
cd "$FRONTEND"
VITE_DEV_API_PROXY=http://localhost:$API_PORT/ nohup ./node_modules/.bin/vite --port "$DASH_PORT" --strictPort > "$STATE/dashboard.log" 2>&1 &
echo $! > "$STATE/dashboard.pid"
VITE_DEV_API_PROXY=http://localhost:$API_PORT/ nohup ./node_modules/.bin/vite --port "$PORTAL_PORT" --strictPort > "$STATE/portal.log" 2>&1 &
echo $! > "$STATE/portal.pid"

# Ready means usable: the API reaches its database, the worker reports in, and both dev
# servers proxy /api to the API.
ready() {
  curl -fsS "http://localhost:$API_PORT/ready" >/dev/null 2>&1 &&
    curl -fsS "http://localhost:$API_PORT/ready/worker" >/dev/null 2>&1 &&
    curl -fsS "http://localhost:$DASH_PORT/api/health" >/dev/null 2>&1 &&
    curl -fsS "http://localhost:$PORTAL_PORT/api/health" >/dev/null 2>&1
}
for _ in $(seq 1 120); do
  if ready; then echo "$STATE/env"; exit 0; fi
  sleep 1
done
echo "not ready after 120s" >&2
false
