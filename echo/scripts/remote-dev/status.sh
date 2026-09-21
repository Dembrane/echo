#!/usr/bin/env bash
# Shows what is running: the VM, its size, the containers, and disk usage.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud

log_step "Instance"
if ! instance_exists; then
    log_warn "'$RD_INSTANCE_NAME' does not exist in $RD_ZONE. Create it with ./create.sh"
    exit 0
fi

gc_zone instances describe "$RD_INSTANCE_NAME" \
    --format='table(name,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)'

DISK_GB="$(gc compute disks describe "$RD_INSTANCE_NAME" --zone "$RD_ZONE" --format='value(sizeGb)' 2>/dev/null || echo '?')"
log_info "Boot disk: ${DISK_GB}GB $RD_DISK_TYPE"

if [ "$(instance_status)" != "RUNNING" ]; then
    log_warn "Instance is not running, so there is nothing else to report. Start it with ./start.sh"
    exit 0
fi

log_step "Containers"
vm_compose "ps" 2>/dev/null || log_warn "Could not reach docker on the VM."

log_step "Directus schema"
# A quick check, not a full diff: it catches a schema that was never pushed or
# is missing collections, but not changed fields. For those, run
# `./sync.sh diff` in the container's directus/ directory.
EXPECTED="$(vm_ssh "ls '$RD_REPO_DIR/echo/directus/sync/snapshot/collections' | wc -l" 2>/dev/null | tr -dc '0-9')"
APPLIED="$(vm_psql "select count(*) from directus_collections" 2>/dev/null | tr -dc '0-9')"
INDEX_LIST="'$(echo "$RD_MEMBERSHIP_INDEXES" | sed "s/ /','/g")'"
INDEXES="$(vm_psql "select count(*) from pg_indexes where indexname in ($INDEX_LIST)" 2>/dev/null | tr -dc '0-9')"
if [ -z "$APPLIED" ] || [ -z "$EXPECTED" ]; then
    log_warn "Could not read the schema state. Is directus up? See the containers above."
elif [ "$APPLIED" -lt "$EXPECTED" ]; then
    log_warn "Schema not applied: $APPLIED of $EXPECTED collections. Run ./up.sh --skip-setup"
else
    log_info "$APPLIED of $EXPECTED collections present."
fi
INDEXES_EXPECTED="$(echo "$RD_MEMBERSHIP_INDEXES" | wc -w | tr -dc '0-9')"
if [ -n "$INDEXES" ] && [ "$INDEXES" -lt "$INDEXES_EXPECTED" ]; then
    log_warn "Membership indexes missing ($INDEXES of $INDEXES_EXPECTED). Run ./up.sh --skip-setup"
fi

log_step "Resources"
vm_ssh "echo '--- memory ---'; free -h; echo; echo '--- disk ---'; df -h / | tail -n +1; echo; echo '--- load ---'; uptime" 2>/dev/null \
    || log_warn "Could not read resource usage."

log_step "Tunnel"
# Checking the local end tells you whether your browser will actually reach
# the dev servers, which is the thing people are really asking about here.
FIRST_PORT="$(echo "$RD_FORWARD_PORTS" | awk '{print $1}')"
if nc -z localhost "$FIRST_PORT" 2>/dev/null; then
    log_info "Port $FIRST_PORT is reachable on localhost. The tunnel looks up."
else
    log_warn "Port $FIRST_PORT is not reachable locally. Open the tunnel with: ./tunnel.sh"
fi
