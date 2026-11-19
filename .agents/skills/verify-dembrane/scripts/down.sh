#!/usr/bin/env bash
# Tears down one verify run: kills only the processes it started, drops its database, removes
# its state dir. Logs are copied into the evidence dir first, and evidence is never deleted.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
pick_run || exit 1
for p in api worker dashboard portal; do
  [ -f "$STATE/$p.pid" ] && kill "$(cat "$STATE/$p.pid")" 2>/dev/null
done
sleep 2
for p in api worker dashboard portal; do
  [ -f "$STATE/$p.pid" ] && kill -9 "$(cat "$STATE/$p.pid")" 2>/dev/null
done
mkdir -p "$EVIDENCE/logs" && cp "$STATE"/*.log "$EVIDENCE/logs/" 2>/dev/null
if [ "$MODE" = docker ]; then
  (cd "$PLATFORM" && docker compose -p "$COMPOSE_PROJECT" down -v) >/dev/null 2>&1
else
  PGPASSWORD=echo dropdb -h localhost -p 5432 -U echo --if-exists "$DB"
fi
rm -rf "$STATE"
for port in "$API_PORT" "$DASH_PORT" "$PORTAL_PORT"; do
  [ -z "$(listener_pid "$port")" ] || echo "warning: something still listens on :$port" >&2
done
echo "torn down $RUN; evidence kept in $EVIDENCE"
