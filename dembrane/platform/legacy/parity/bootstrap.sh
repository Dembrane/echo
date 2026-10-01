#!/usr/bin/env bash
# Builds the parity stack from nothing: echo main's schema through the same path main
# deploys it (Directus bootstrap, directus-sync push, the SQL-only migrations), checks
# the result against echo-next's schema, seeds fixed data and freezes it as the
# template database every scenario starts from.
#   legacy/parity/bootstrap.sh            full rebuild (drops the parity volume)
#   SKIP_SCHEMA_CHECK=1 ...        skip the echo-next comparison
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/old-echo.sh"
echo_root="$OLD_ECHO_DIR/echo"
cd "$here"
start=$(date +%s)

# One place for secrets; generated once, reused on rebuilds so logins stay stable.
if [[ ! -f .env.parity ]]; then
  gen() { openssl rand -hex 16; }
  umask 077
  cat > .env.parity <<EOF
DIRECTUS_SECRET=$(gen)$(gen)
DIRECTUS_TOKEN=$(gen)
PARITY_ADMIN_EMAIL=admin@dembrane.com
PARITY_ADMIN_PASSWORD=$(gen)
PARITY_USER_PASSWORD=$(gen)
EOF
fi
# The Python API's model settings: copied from the hand-written local echo .env (Vertex,
# gcloud ADC) when present, so LLM-backed endpoints work; without it they fail at call time.
llm_src="${ECHO_LLM_ENV:-$HOME/orca/echo/echo/server/.env}"
if ! grep -q '^LLM__' .env.parity && [[ -f "$llm_src" ]]; then
  grep -E '^(LLM__|EMBEDDING_|GOOGLE_APPLICATION_CREDENTIALS=|ENABLE_CANVAS=)' "$llm_src" >> .env.parity
fi
if ! grep -q '^PARITY_AGENT_ACCESS_TOKEN=' .env.parity; then
  echo "PARITY_AGENT_ACCESS_TOKEN=dbr_at_$(openssl rand -hex 24)" >> .env.parity
  echo "PARITY_AGENT_REFRESH_TOKEN=dbr_rt_$(openssl rand -hex 24)" >> .env.parity
fi
set -a; source .env.parity; set +a

dc() { docker compose -f "$here/compose.yml" --env-file "$here/.env.parity" "$@"; }
psql_db() { dc exec -T db psql -U dembrane -d "${1:-dembrane}" -v ON_ERROR_STOP=1 -q "${@:2}"; }

echo "== fresh stack"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc build -q directus
dc up -d --wait db valkey
# echo main enables pgvector by hand before the push (main's echo/docs/database_migrations.md step 3).
psql_db dembrane -c "create extension if not exists vector"
dc up -d --wait directus

echo "== directus-sync diff + push"
# CLI pinned to the release that matches the extension inside tractr/directus-sync:11.13.4.
sync() {
  (cd "$echo_root/directus" && zsh -lic "npx -y directus-sync@3.5.1 -u http://localhost:8065 \
    -e '$PARITY_ADMIN_EMAIL' -p '$PARITY_ADMIN_PASSWORD' $*" )
}
sync diff > "$here/.last-sync-diff.log" 2>&1 || { tail -30 "$here/.last-sync-diff.log"; exit 1; }
sync push > "$here/.last-sync-push.log" 2>&1 || { tail -30 "$here/.last-sync-push.log"; exit 1; }

echo "== SQL-only migrations (main's echo/docs/database_migrations.md steps 5-7)"
# Step 4 (the partial unique indexes on org_membership and workspace_membership) is
# skipped on purpose: neither echo-next nor prod has them, and parity follows what runs.
psql_db dembrane < "$echo_root/directus/migrations/add_map_vectors.sql"
psql_db dembrane < "$echo_root/directus/migrations/add_analysis_constraints.sql"
echo "schema ready after $(( $(date +%s) - start ))s"

if [[ -z "${SKIP_SCHEMA_CHECK:-}" ]]; then
  echo "== schema vs echo-next"
  "$here/schema-check.sh"
fi

echo "== Python API startup seed (languages, default verification topics)"
# main.py's lifespan writes these on first start; doing it here keeps them in the
# template instead of letting whichever API starts first create them.
log="$here/.last-startup-seed.log"
PARITY_API_PORT=8199 setsid "$here/run-old-api.sh" > "$log" 2>&1 &
api_pid=$!
for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:8199/api/health >/dev/null && break
  kill -0 $api_pid 2>/dev/null || { tail -20 "$log"; exit 1; }
  sleep 1
done
grep -q "Application startup complete" "$log" || { tail -20 "$log"; exit 1; }
kill -INT -- -"$api_pid" 2>/dev/null || true
wait $api_pid 2>/dev/null || true

echo "== seed"
(cd "$here" && bun seed.ts)

echo "== template"
dc stop directus >/dev/null
psql_db postgres -c "drop database if exists parity_template" -c "create database parity_template template dembrane"
dc start directus >/dev/null
dc up -d --wait directus
echo "bootstrap done in $(( $(date +%s) - start ))s"
