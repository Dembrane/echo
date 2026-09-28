#!/usr/bin/env bash
# Runs echo main's Python API (OLD_ECHO_DIR's echo/server) against the parity stack on
# :8100. Settings come from .env.parity; addresses are fixed here. Extra args go to uvicorn.
#   parity/run-old-api.sh            foreground
#   PARITY_DB=scenario_1 parity/run-old-api.sh   point at another database from reset.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/old-echo.sh"
server="$OLD_ECHO_DIR/echo/server"
# settings.py loads server/.env with override=True, which would silently beat this env.
[[ -f "$server/.env" ]] && { echo "refusing: $server/.env exists and would override parity settings" >&2; exit 1; }
set -a; source "$here/.env.parity"; set +a
export DIRECTUS_BASE_URL=http://localhost:8065
export DATABASE_URL="postgresql+psycopg://dembrane:dembrane@localhost:5440/${PARITY_DB:-dembrane}"
export REDIS_URL=redis://localhost:6395
export API_BASE_URL=http://localhost:8100
export ADMIN_BASE_URL=http://localhost:5173
export PARTICIPANT_BASE_URL=http://localhost:5174
export DISABLE_SENTRY=1 SERVE_API_DOCS=1 DISABLE_REDACTION=1
# No object store in the parity stack: audio upload and download paths fail.
export STORAGE_S3_KEY=parity STORAGE_S3_SECRET=parity STORAGE_S3_BUCKET=parity STORAGE_S3_ENDPOINT=http://127.0.0.1:9
cd "$server"
exec zsh -lic "uv run --frozen uvicorn dembrane.main:app --host 127.0.0.1 --port ${PARITY_API_PORT:-8100} --loop asyncio $*"
