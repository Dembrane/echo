#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-echo}"

say() { printf '%s\n' "$*"; }

say "[run-all] Repo: $ROOT_DIR"

# Start infra services if docker is available.
# Skip if we're inside a devcontainer unless explicitly overridden.
if [ -n "${FORCE_DOCKER:-}" ]; then
  IN_DEVCONTAINER=0
elif [ -n "${DEVCONTAINER:-}" ] || [ -n "${REMOTE_CONTAINERS:-}" ] || [ -n "${VSCODE_REMOTE_CONTAINERS_SESSION:-}" ] || [ -n "${CODESPACES:-}" ]; then
  IN_DEVCONTAINER=1
else
  IN_DEVCONTAINER=0
fi

if [ "$IN_DEVCONTAINER" -eq 1 ]; then
  say "[run-all] Detected devcontainer; skipping infra services (set FORCE_DOCKER=1 to override)."
elif command -v docker >/dev/null 2>&1; then
  say "[run-all] Starting infra services (postgres, redis, neo4j, directus)..."
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$ROOT_DIR/.devcontainer/docker-compose.yml" up -d postgres redis neo4j directus

  if [ "${RUN_MINIO:-0}" = "1" ]; then
    say "[run-all] Starting MinIO (S3-compatible storage)..."
    docker compose -p "$COMPOSE_PROJECT_NAME" -f "$ROOT_DIR/.devcontainer/docker-compose-s3.yml" up -d
  fi
else
  say "[run-all] Docker not found; skipping infra services."
fi

# Backend API + workers
say "[run-all] Starting backend and workers..."
nohup bash -lc "cd '$ROOT_DIR/server' && ./run.sh" > "$LOG_DIR/server.log" 2>&1 &
nohup bash -lc "cd '$ROOT_DIR/server' && ./run-worker.sh" > "$LOG_DIR/worker.log" 2>&1 &
nohup bash -lc "cd '$ROOT_DIR/server' && ./run-worker-cpu.sh" > "$LOG_DIR/worker-cpu.log" 2>&1 &
nohup bash -lc "cd '$ROOT_DIR/server' && ./run-scheduler.sh" > "$LOG_DIR/scheduler.log" 2>&1 &

# Frontend
say "[run-all] Starting frontends..."
nohup bash -lc "cd '$ROOT_DIR/frontend' && pnpm install" > "$LOG_DIR/frontend-install.log" 2>&1 &
nohup bash -lc "cd '$ROOT_DIR/frontend' && pnpm run dev" > "$LOG_DIR/frontend-admin.log" 2>&1 &
nohup bash -lc "cd '$ROOT_DIR/frontend' && pnpm run participant:dev" > "$LOG_DIR/frontend-participant.log" 2>&1 &

# Usage tracker
say "[run-all] Starting usage tracker..."
nohup bash -lc "cd '$ROOT_DIR/tools/usage-tracker' && uv run streamlit run app.py --server.address 0.0.0.0 --server.port 8501" > "$LOG_DIR/usage-tracker.log" 2>&1 &

say "[run-all] Done. Check logs in $LOG_DIR"
