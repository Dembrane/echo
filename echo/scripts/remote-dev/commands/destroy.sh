#!/usr/bin/env bash
# Deletes the VM and its boot disk. This is not reversible.
#
# Everything on the VM goes with it: uncommitted work, the postgres data
# directory, directus uploads, and all docker images. Push anything you care
# about first. If you only want to stop paying for compute, use `stop`
# instead, which keeps the disk.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

require_gcloud

if ! instance_exists; then
    log_info "'$RD_INSTANCE_NAME' does not exist. Nothing to delete."
    exit 0
fi

log_warn "About to DELETE instance '$RD_INSTANCE_NAME' and its boot disk in $RD_ZONE (project $RD_PROJECT)."
log_warn "This destroys all uncommitted work, the database, and directus uploads."

if [ "$(instance_status)" = "RUNNING" ]; then
    log_step "Uncommitted changes on the VM"
    vm_ssh "cd '$RD_REPO_DIR' && git status --short && git stash list" 2>/dev/null \
        || log_warn "Could not read git status."
fi

echo
read -r -p "$(echo -e "\033[0;31mType the instance name to confirm:\033[0m ")" CONFIRM </dev/tty
[ "$CONFIRM" = "$RD_INSTANCE_NAME" ] || die "Confirmation did not match. Nothing was deleted."

log_step "Deleting"
gc_zone instances delete "$RD_INSTANCE_NAME" --quiet --delete-disks=all
log_info "Deleted."

log_info "Remove the stale SSH host entries with: ./scripts/remote-dev.sh ssh-config --remove"
