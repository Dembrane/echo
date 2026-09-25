#!/usr/bin/env bash
# Stops the VM. Run this whenever you finish for the day.
#
# A stopped VM bills only for its persistent disk, which is a few dollars a
# month, versus a few hundred for leaving 24/7 compute running. The disk keeps
# everything: the repo, docker images, node_modules, the postgres data
# directory, and any uncommitted work.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

require_gcloud
require_instance

STATUS="$(instance_status)"
if [ "$STATUS" = "TERMINATED" ]; then
    log_info "Already stopped."
    exit 0
fi

# Stopping the VM pulls the rug from under running containers. Postgres
# survives an abrupt shutdown, but a clean compose stop avoids the recovery
# pass and any half-written directus uploads. This stops every container in the
# project: one left running, like minio with its restart policy, comes back on
# its own at the next boot while the rest stay down.
log_step "Stopping containers"
vm_compose_project "stop" 2>/dev/null || log_warn "Could not stop containers cleanly; continuing."

log_step "Stopping '$RD_INSTANCE_NAME'"
gc_zone instances stop "$RD_INSTANCE_NAME" --quiet

log_info "Stopped. Disk is retained; restart with ./scripts/remote-dev.sh start"
