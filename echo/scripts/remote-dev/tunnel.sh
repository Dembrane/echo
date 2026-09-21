#!/usr/bin/env bash
# Forwards the dev ports from the VM to your laptop and stays in the
# foreground. Leave it running in its own terminal tab; ctrl-c closes it.
#
# Ports are mapped 1:1 on purpose. docker-compose.yml hardcodes localhost
# origins (CORS_ORIGIN=http://localhost:5173, PUBLIC_URL=http://localhost:8055,
# USER_INVITE_URL_ALLOW_LIST=http://localhost:5173/invite), so keeping the same
# numbers locally means none of that config has to change for remote work, and
# directus sessions and CORS behave exactly as they do on a laptop.
#
# Nothing is exposed publicly. The GCP firewall only ever opens port 22; every
# one of these ports travels inside the SSH connection.
#
#   ./tunnel.sh              forward the default port set
#   ./tunnel.sh 5173 8000    forward only these

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud
require_running

PORTS="${*:-$RD_FORWARD_PORTS}"

# A port already bound locally makes ssh drop that one forward and carry on
# silently, which is confusing to debug later. Say so up front instead.
CONFLICTS=""
for p in $PORTS; do
    if nc -z localhost "$p" 2>/dev/null; then
        CONFLICTS="$CONFLICTS $p"
    fi
done
if [ -n "$CONFLICTS" ]; then
    log_warn "Already in use locally:$CONFLICTS"
    log_warn "Those forwards will be skipped by ssh. Stop whatever holds them, or pass a narrower port list."
fi

FORWARD_ARGS=()
for p in $PORTS; do
    FORWARD_ARGS+=(-L "${p}:localhost:${p}")
done

log_step "Forwarding"
for p in $PORTS; do
    case "$p" in
        5173) echo "  http://localhost:5173   admin dashboard (admin@dembrane.com / admin)" ;;
        5174) echo "  http://localhost:5174   participant portal" ;;
        8000) echo "  http://localhost:8000   backend API (docs at /docs)" ;;
        8055) echo "  http://localhost:8055   directus (admin@dembrane.com / admin)" ;;
        8001) echo "  http://localhost:8001   agent service" ;;
        5432) echo "  localhost:5432          postgres (dembrane/dembrane)" ;;
        9000) echo "  http://localhost:9000   minio S3 API" ;;
        9001) echo "  http://localhost:9001   minio console" ;;
        *)    echo "  localhost:$p" ;;
    esac
done
echo
log_info "Tunnel is open. Leave this running; ctrl-c to close."

# Forward to the VM, not into the devcontainer: the compose file already
# publishes every one of these ports on the VM's own loopback interface, so one
# hop is enough and a second would just add latency.
#
# No `exec` here: gc_ssh is a shell function, and exec only replaces the
# process with a real binary.
gc_ssh -- -N "${FORWARD_ARGS[@]}" \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ExitOnForwardFailure=no
