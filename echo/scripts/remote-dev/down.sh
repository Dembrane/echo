#!/usr/bin/env bash
# Stops the containers but leaves the VM running.
#
# Use this to free memory on a small VM without waiting out a full VM restart.
# To stop paying for compute, use ./stop.sh instead.
#
#   ./down.sh            stop containers, keep volumes
#   ./down.sh --volumes  also delete named volumes (the bind-mounted
#                        postgres_data/redis_data directories survive either way)

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud
require_running

if [ "${1:-}" = "--volumes" ]; then
    log_warn "Removing containers and named volumes."
    vm_compose "down --volumes"
else
    log_step "Stopping containers"
    vm_compose "down"
fi

log_info "Containers stopped. Bring them back with ./up.sh"
