#!/usr/bin/env bash
# Creates or deletes the VM that runs the Storage Transfer agents for files-sync.sh.
#
#   legacy/ops/transfer-agents.sh up      create the VM (no-op when it exists); agents start at boot
#   legacy/ops/transfer-agents.sh down    delete the VM once the last pass is done
#
# PROJECT (dembrane-web-prod), ZONE (europe-west4-a), VM (echo-cutover-transfer),
# MACHINE (n2-standard-8: 16 Gbps egress cap, enough CPU for 8 agents), AGENTS (8),
# AGENT_POOL, SPACES_SECRET (secret with the Spaces keys), SA (the agents' identity: needs
# roles/storagetransfer.transferAgent, objectAdmin on the sink bucket, and accessor on the secret).
source "$(dirname "$0")/lib.sh"
PROJECT="${PROJECT:-dembrane-web-prod}"
ZONE="${ZONE:-europe-west4-a}"
VM="${VM:-echo-cutover-transfer}"
g() { gcloud --project "$PROJECT" "$@"; }

case "${1:-}" in
  up)
    : "${AGENT_POOL:?}" "${SPACES_SECRET:?}" "${SA:?}"
    if g compute instances describe "$VM" --zone "$ZONE" --format='value(name)' >/dev/null 2>&1; then
      log "$VM exists"; exit 0
    fi
    g compute instances create "$VM" --zone "$ZONE" --machine-type "${MACHINE:-n2-standard-8}" \
      --image-family cos-stable --image-project cos-cloud --boot-disk-size 30GB \
      --service-account "$SA" --scopes cloud-platform --labels purpose=echo-cutover \
      --metadata "agent-pool=$AGENT_POOL,spaces-secret=$SPACES_SECRET,agents=${AGENTS:-8}" \
      --metadata-from-file "startup-script=$OPS_DIR/transfer-agents-startup.sh"
    ;;
  down) g compute instances delete "$VM" --zone "$ZONE" --quiet ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
