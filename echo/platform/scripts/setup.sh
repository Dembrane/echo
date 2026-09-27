#!/usr/bin/env bash
# One command from clone to running: Postgres up, dependencies installed, schema migrated.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { cp .env.example .env.local; echo "AUTH_SECRET=$(head -c 32 /dev/urandom | base64)" >> .env.local; echo "INVITE_HASH_SECRET=$(head -c 32 /dev/urandom | base64)" >> .env.local; }
bun install
docker compose up -d --wait db
set -a; . ./.env.local; set +a
MIGRATION_DATABASE_URL="$DATABASE_URL" bun packages/db/src/migrate.ts
echo "ready: bun run dev"
