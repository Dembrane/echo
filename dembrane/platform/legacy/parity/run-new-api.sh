#!/usr/bin/env bash
# Runs this worktree's Bun API against the parity stack, configured to answer like
# run-old-api.sh does. Settings come from .env.parity; addresses are fixed here.
#   legacy/parity/run-new-api.sh                    foreground on :8200
#   PARITY_API_PORT=8212 legacy/parity/run-new-api.sh
#   PARITY_NEW_URL=http://127.0.0.1:8212 legacy/parity/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$here/.env.parity"; set +a
export APP_ENV=local
export PORT="${PARITY_API_PORT:-8200}"
export DATABASE_URL="postgres://dembrane:dembrane@localhost:5440/${PARITY_DB:-dembrane}"
# A fixed secret; parity signs nothing that outlives a run.
export AUTH_SECRET=parity-secret-parity-secret-parity-secret-00
# Invite links and stored MCP client secrets are keyed on Directus's SECRET until cutover.
export INVITE_HASH_SECRET="$DIRECTUS_SECRET"
# The old API's public address, so OAuth metadata and links printed by both sides match.
export API_PUBLIC_URL=http://localhost:8100
export DASHBOARD_URL=http://localhost:5173 PORTAL_URL=http://localhost:5174
# No object store in the parity stack, same dead endpoint as the old API: audio paths fail alike.
export STORAGE_S3_KEY=parity STORAGE_S3_SECRET=parity STORAGE_S3_BUCKET=parity STORAGE_S3_ENDPOINT=http://127.0.0.1:9
# The Vertex project and embedding region the old API's LLM__* and EMBEDDING_BASE_URL point at.
export LLM_VERTEX_PROJECT=dembrane-sameer-cli EMBEDDING_LOCATION=europe-west1
cd "$here/../.."
exec bun apps/api/src/main.ts "$@"
