#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '%s\n' "$*"; }

say "[stop-all] Stopping app processes..."

# Stop infra services if docker is available.
if command -v docker >/dev/null 2>&1; then
  say "[stop-all] Stopping infra services (postgres, redis, neo4j, directus)..."
  docker compose -f "$ROOT_DIR/.devcontainer/docker-compose.yml" stop postgres redis neo4j directus || true

  if [ "${RUN_MINIO:-0}" = "1" ]; then
    say "[stop-all] Stopping MinIO (S3-compatible storage)..."
    docker compose -f "$ROOT_DIR/.devcontainer/docker-compose-s3.yml" down || true
  fi
else
  say "[stop-all] Docker not found; skipping infra services."
fi

# Stop backend and workers
pkill -f "cd '$ROOT_DIR/server' && ./run.sh" || true
pkill -f "cd '$ROOT_DIR/server' && ./run-worker.sh" || true
pkill -f "cd '$ROOT_DIR/server' && ./run-worker-cpu.sh" || true
pkill -f "cd '$ROOT_DIR/server' && ./run-scheduler.sh" || true

# Kill any remaining backend processes
pkill -9 -f "uvicorn dembrane" || true
pkill -9 -f "dramatiq" || true
pkill -9 -f "dembrane.scheduler" || true

# Stop frontends
pkill -f "cd '$ROOT_DIR/frontend' && pnpm install" || true
pkill -f "cd '$ROOT_DIR/frontend' && pnpm run dev" || true
pkill -f "cd '$ROOT_DIR/frontend' && pnpm run participant:dev" || true

# Kill any remaining frontend node processes on dev ports
pkill -9 -f "node.*vite.*517" || true

# Stop usage tracker
pkill -f "uv run streamlit run app.py --server.address 0.0.0.0 --server.port 8501" || true
pkill -9 -f "streamlit" || true

# Free up ports explicitly
say "[stop-all] Freeing ports..."
fuser -k 5173/tcp 5174/tcp 5175/tcp 5176/tcp 5177/tcp 5178/tcp 5179/tcp 5180/tcp 8000/tcp 8055/tcp 8501/tcp 2>/dev/null || true

say "[stop-all] Done."
