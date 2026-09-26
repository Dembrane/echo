#!/usr/bin/env bash
# Shows what is running: APIs, the VM, its size, the containers, and disk usage.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

require_gcloud

# Before the instance checks, which exit early: the APIs belong to the project
# and are worth seeing even with no VM. The metrics pages can be grouped by
# credential, which shows which account made the calls.
log_step "APIs"
if ENABLED_APIS="$(gc services list --enabled --format='value(config.name)' 2>/dev/null)"; then
    for api in $RD_APIS; do
        if echo "$ENABLED_APIS" | grep -qx "$api"; then
            log_info "$api enabled: $(api_metrics_url "$api")"
        else
            log_warn "$api not enabled"
        fi
    done
else
    log_warn "Could not list the enabled APIs on '$RD_PROJECT'."
fi

log_step "Instance"
if ! instance_exists; then
    log_warn "'$RD_INSTANCE_NAME' does not exist in $RD_ZONE. Create it with ./scripts/remote-dev.sh create"
    exit 0
fi

gc_zone instances describe "$RD_INSTANCE_NAME" \
    --format='table(name,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)'

DISK_GB="$(gc compute disks describe "$RD_INSTANCE_NAME" --zone "$RD_ZONE" --format='value(sizeGb)' 2>/dev/null || echo '?')"
log_info "Boot disk: ${DISK_GB}GB $RD_DISK_TYPE"

if [ "$(instance_status)" != "RUNNING" ]; then
    log_warn "Instance is not running, so there is nothing else to report. Start it with ./scripts/remote-dev.sh start"
    exit 0
fi

log_step "Containers"
# --all lists stopped containers too, which is usually what is wrong. Trimmed
# to fit narrower terminals: no name (service says the same), image truncated
# with … like docker's command column, and ports as published->target (one
# number when they match) without the IPv4/IPv6 addresses. Unpublished ports
# are in parentheses.
# A range has no column name, so the header is printed here and `column`
# aligns it; macOS's BSD column has no long flags, hence -t -s.
if CONTAINERS="$(vm_compose_project "ps --all --format '{{.Service}}\t{{if gt (len .Image) 40}}{{truncate .Image 39}}…{{else}}{{.Image}}{{end}}\t{{.Command}}\t{{.RunningFor}}\t{{.Status}}\t{{range .Publishers}}{{if .PublishedPort}}{{if eq .URL \"0.0.0.0\"}}{{.PublishedPort}}{{if ne .PublishedPort .TargetPort}}->{{.TargetPort}}{{end}} {{end}}{{else}}({{.TargetPort}}) {{end}}{{end}}'" 2>/dev/null)"; then
    printf 'SERVICE\tIMAGE\tCOMMAND\tCREATED\tSTATUS\tPORTS\n%s\n' "$CONTAINERS" | column -t -s "$(printf '\t')"
else
    log_warn "Could not reach docker on the VM."
fi
ORPHANS="$(container_orphans || true)"
if [ -n "$ORPHANS" ]; then
    log_warn "Processes left over from an earlier mprocs, still running with the .env they started with:"
    echo "$ORPHANS" | awk -F'\t' '{print "  " $2 "  " $3}'
    log_warn "Stop them with ./scripts/remote-dev.sh ssh, which offers to before opening the shell."
fi
if ! minio_enabled; then
    log_warn "minio is off, so file uploads and recordings fail. Enable with: $RD_MINIO_ENABLE_HINT"
elif ! minio_host_resolves; then
    log_warn "No 'minio' entry in /etc/hosts, so the browser cannot resolve the upload URLs. Add one with:"
    log_warn "  $RD_MINIO_HOSTS_HINT"
fi

log_step "Directus schema"
# A quick check, not a full diff: it catches a schema that was never pushed or
# is missing collections, but not changed fields. For those, run
# `./sync.sh diff` in the container's directus/ directory.
# `|| true` keeps a failed query (postgres down) from exiting the script under
# `set -e`, so the warning below gets printed instead. `tr` runs on the laptop,
# and macOS's BSD tr has no long flags, hence -dc.
EXPECTED="$(vm_ssh "ls '$RD_REPO_DIR/echo/directus/sync/snapshot/collections' | wc --lines" 2>/dev/null | tr -dc '0-9' || true)"
APPLIED="$(vm_psql "select count(*) from directus_collections" 2>/dev/null | tr -dc '0-9' || true)"
INDEX_LIST="'$(echo "$RD_MEMBERSHIP_INDEXES" | sed "s/ /','/g")'"
INDEXES="$(vm_psql "select count(*) from pg_indexes where indexname in ($INDEX_LIST)" 2>/dev/null | tr -dc '0-9' || true)"
if [ -z "$APPLIED" ] || [ -z "$EXPECTED" ]; then
    log_warn "Could not read the schema state. Is directus up? See the containers above."
elif [ "$APPLIED" -lt "$EXPECTED" ]; then
    log_warn "Schema not applied: $APPLIED of $EXPECTED collections. Run ./scripts/remote-dev.sh up --skip-setup"
else
    log_info "$APPLIED of $EXPECTED collections present."
fi
INDEXES_EXPECTED="$(echo "$RD_MEMBERSHIP_INDEXES" | wc -w | tr -dc '0-9')"
if [ -n "$INDEXES" ] && [ "$INDEXES" -lt "$INDEXES_EXPECTED" ]; then
    log_warn "Membership indexes missing ($INDEXES of $INDEXES_EXPECTED). Run ./scripts/remote-dev.sh up --skip-setup"
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
    log_warn "Port $FIRST_PORT is not reachable locally. Open the tunnel with: ./scripts/remote-dev.sh tunnel"
fi
