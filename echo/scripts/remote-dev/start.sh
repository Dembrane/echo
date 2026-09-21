#!/usr/bin/env bash
# Starts the stopped VM and refreshes the SSH config.
#
# The external IP is ephemeral, so it changes on every start. That is why this
# re-runs ssh-config.sh: without it, Zed would keep dialing yesterday's IP.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud
require_instance

STATUS="$(instance_status)"
if [ "$STATUS" = "RUNNING" ]; then
    log_info "Already running at $(instance_ip)"
else
    log_step "Starting '$RD_INSTANCE_NAME'"
    gc_zone instances start "$RD_INSTANCE_NAME" --quiet
fi

log_step "Waiting for SSH"
for i in $(seq 1 30); do
    if vm_ssh "true" >/dev/null 2>&1; then
        log_info "SSH is up at $(instance_ip)"
        break
    fi
    [ "$i" -eq 30 ] && die "SSH did not come up after 5 minutes."
    printf '.'
    sleep 10
done
echo

"$RD_SCRIPT_DIR/ssh-config.sh"

log_step "Next"
cat <<EOF
The containers do not auto-start after a reboot. Bring the stack back with:
  ./up.sh
EOF
