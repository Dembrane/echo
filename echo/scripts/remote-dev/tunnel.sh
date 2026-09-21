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

# Print one port's row, with the scheme right-aligned so every "://" lines up.
# An optional second argument is appended to the description.
print_port() {
    local p="$1" note="${2:-}" scheme desc
    case "$p" in
        5173) scheme=http;       desc="admin dashboard (admin@dembrane.com / admin)" ;;
        5174) scheme=http;       desc="participant portal" ;;
        8000) scheme=http;       desc="backend API (docs at /docs)" ;;
        8055) scheme=http;       desc="directus (admin@dembrane.com / admin)" ;;
        8001) scheme=http;       desc="agent service" ;;
        5432) scheme=postgresql; desc="postgres (dembrane/dembrane)" ;;
        9000) scheme=http;       desc="minio S3 API" ;;
        9001) scheme=http;       desc="minio console" ;;
        *)    printf '  %13s%s\n' "" "localhost:$p"; return ;;
    esac
    printf '  %10s://localhost:%-5s  %s%s\n' "$scheme" "$p" "$desc" "$note"
}

log_step "Forwarding"
for p in $PORTS; do
    print_port "$p"
done
# minio's ports are not forwarded while it is off, but list them anyway so
# people know it exists and that uploads depend on it.
if ! minio_enabled; then
    print_port 9000 "   [off, not forwarded]"
    print_port 9001 "  [off, not forwarded]"
    echo
    echo "  minio is off, so uploads and recordings fail. Enable with:"
    echo "    $RD_MINIO_ENABLE_HINT"
fi
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
