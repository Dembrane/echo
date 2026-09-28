#!/usr/bin/env bash
# Stops the containers but leaves the VM running.
#
# Use this to free memory on a small VM without waiting out a full VM restart.
# To stop paying for compute, use ./scripts/remote-dev.sh stop instead.
#
#   ./scripts/remote-dev.sh down            stop containers, keep volumes
#   ./scripts/remote-dev.sh down --volumes  also delete named volumes (the
#                                           bind-mounted postgres_data/redis_data
#                                           directories survive either way)

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

require_gcloud
require_running

# --remove-orphans so this takes everything down, including a service the
# configured compose files no longer define. minio becomes exactly that once
# it is turned off, and it would otherwise keep running after a "down".
if [ "${1:-}" = "--volumes" ]; then
    log_warn "Removing containers and named volumes."
    vm_compose "down --volumes --remove-orphans"
else
    log_step "Stopping containers"
    vm_compose "down --remove-orphans"
fi

log_info "Containers stopped. Bring them back with ./scripts/remote-dev.sh up"
