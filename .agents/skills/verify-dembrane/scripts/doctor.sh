#!/usr/bin/env bash
# Read-only: is this verify run worth driving? Exit 0 only when every check passes.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
pick_run || exit 1
ok=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; ok=1; fi; }
echo "run $RUN ($MODE, db $DB on :$DB_PORT, code @ $COMMIT)"
for p in api worker dashboard portal; do
  check "$p process alive" "kill -0 \$(cat '$STATE/$p.pid')"
done
check "api owns :$API_PORT" "[ \"\$(listener_pid $API_PORT)\" = \"\$(cat '$STATE/api.pid')\" ]"
check "dashboard owns :$DASH_PORT" "[ \"\$(listener_pid $DASH_PORT)\" = \"\$(cat '$STATE/dashboard.pid')\" ]"
check "portal owns :$PORTAL_PORT" "[ \"\$(listener_pid $PORTAL_PORT)\" = \"\$(cat '$STATE/portal.pid')\" ]"
check "api ready (database reachable)" "curl -fsS $API_URL/ready"
check "worker reporting in" "curl -fsS $API_URL/ready/worker"
check "dashboard proxies /api" "curl -fsS $DASHBOARD_URL/api/health"
check "portal proxies /api" "curl -fsS http://localhost:$PORTAL_PORT/api/health"
check "platform code unchanged since launch (else restart: API and worker don't reload)" \
  "[ \"\$(platform_fingerprint)\" = '$PLATFORM_FINGERPRINT' ]"
exit $ok
