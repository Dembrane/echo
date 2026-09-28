#!/usr/bin/env bash
# Changes the VM's machine type, its disk size, or both.
#
#   ./scripts/remote-dev.sh resize e2-standard-8  # more CPU and RAM
#   ./scripts/remote-dev.sh resize --disk 200GB   # more disk
#   ./scripts/remote-dev.sh resize e2-standard-8 --disk 200GB
#
# Machine type changes require the VM to be stopped, so this stops and
# restarts it for you. Nothing on the disk is touched, so the stack and all
# your work survive.
#
# Disks can only grow, never shrink. That is a GCP limit, not a script one.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

NEW_MACHINE=""
NEW_DISK=""

while [ $# -gt 0 ]; do
    case "$1" in
        --disk) NEW_DISK="$2"; shift 2 ;;
        -h|--help) header_help "$0"; exit 0 ;;
        -*) die "Unknown option: $1" ;;
        *) NEW_MACHINE="$1"; shift ;;
    esac
done

[ -n "$NEW_MACHINE" ] || [ -n "$NEW_DISK" ] \
    || die "Nothing to do. Pass a machine type, --disk SIZE, or both. See --help."

require_gcloud
require_instance

CURRENT_MACHINE="$(gc_zone instances describe "$RD_INSTANCE_NAME" --format='value(machineType)' | sed 's|.*/||')"
CURRENT_DISK="$(gc compute disks describe "$RD_INSTANCE_NAME" --zone "$RD_ZONE" --format='value(sizeGb)' 2>/dev/null || echo '?')"
log_info "Current: $CURRENT_MACHINE, ${CURRENT_DISK}GB disk"

# Growing a disk works on a running VM; the filesystem is expanded on the next
# boot by Ubuntu's growpart, so do this before any stop/start below.
if [ -n "$NEW_DISK" ]; then
    log_step "Resizing disk to $NEW_DISK"
    gc compute disks resize "$RD_INSTANCE_NAME" --zone "$RD_ZONE" --size "$NEW_DISK" --quiet
    log_info "Disk resized. The filesystem grows automatically on next boot."
    persist_local_env RD_DISK_SIZE "$NEW_DISK"
fi

if [ -n "$NEW_MACHINE" ]; then
    WAS_RUNNING=false
    if [ "$(instance_status)" = "RUNNING" ]; then
        WAS_RUNNING=true
        log_step "Stopping instance (required to change machine type)"
        gc_zone instances stop "$RD_INSTANCE_NAME" --quiet
    fi

    log_step "Setting machine type to $NEW_MACHINE"
    gc_zone instances set-machine-type "$RD_INSTANCE_NAME" --machine-type "$NEW_MACHINE"

    if [ "$WAS_RUNNING" = true ]; then
        log_step "Starting instance"
        gc_zone instances start "$RD_INSTANCE_NAME" --quiet
    fi

    # Persist the new size so create.sh would rebuild at the same shape.
    persist_local_env RD_MACHINE_TYPE "$NEW_MACHINE"
fi

log_step "Done"
if [ -n "$NEW_MACHINE" ]; then
    # Run up.sh, not `docker compose up`: the reboot recreates the containers,
    # and a fresh devcontainer starts with an empty authorized_keys, so only
    # up.sh's key install gets Zed back in. The tunnel died with the VM too.
    log_warn "The VM rebooted, so the containers are down."
    echo
    echo "  Bring the stack back, which also reinstalls your SSH key:"
    echo "    ./scripts/remote-dev.sh up"
    echo
    echo "  Then reopen port forwarding in its own tab:"
    echo "    ./scripts/remote-dev.sh tunnel"
fi
