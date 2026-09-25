#!/usr/bin/env bash
# Creates the dev VM: enables the Compute API if needed, makes sure an SSH
# firewall rule exists, boots an Ubuntu instance, and runs bootstrap-vm.sh to
# install docker and clone the repo.
#
# Idempotent. If the instance already exists this reports its state and exits
# without touching it.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

log_step "Preflight"
require_gcloud
require_compute_api
log_info "Project $RD_PROJECT, zone $RD_ZONE"

if instance_exists; then
    log_warn "Instance '$RD_INSTANCE_NAME' already exists (state: $(instance_status))."
    log_info "To start it:   ./start.sh"
    log_info "To replace it: ./destroy.sh && ./create.sh"
    exit 0
fi

# The default network usually ships with default-allow-ssh, but a project
# created from a custom template may not have it. Only port 22 is ever opened.
# The devcontainer's own sshd on 2222 stays private and is reached by jumping
# through this one.
log_step "Firewall"
if gc compute firewall-rules describe default-allow-ssh >/dev/null 2>&1; then
    log_info "default-allow-ssh already present"
else
    log_warn "No default-allow-ssh rule. Creating one (tcp:22 only)."
    gc compute firewall-rules create default-allow-ssh \
        --network=default \
        --allow=tcp:22 \
        --source-ranges=0.0.0.0/0 \
        --description="Allow SSH from anywhere (dembrane remote dev)"
fi

log_step "Creating instance '$RD_INSTANCE_NAME'"
log_info "$RD_MACHINE_TYPE, $RD_DISK_SIZE $RD_DISK_TYPE, $RD_IMAGE_FAMILY"

gc compute instances create "$RD_INSTANCE_NAME" \
    --zone="$RD_ZONE" \
    --machine-type="$RD_MACHINE_TYPE" \
    --image-family="$RD_IMAGE_FAMILY" \
    --image-project="$RD_IMAGE_PROJECT" \
    --boot-disk-size="$RD_DISK_SIZE" \
    --boot-disk-type="$RD_DISK_TYPE" \
    --boot-disk-device-name="$RD_INSTANCE_NAME" \
    --metadata-from-file=startup-script="$RD_SCRIPT_DIR/bootstrap-vm.sh" \
    --metadata="dembrane-repo-url=$RD_REPO_URL,dembrane-repo-dir=$RD_REPO_DIR,dembrane-user=$RD_REMOTE_USER" \
    --labels="purpose=dev,managed-by=remote-dev-scripts" \
    --scopes=cloud-platform

IP="$(instance_ip)"
log_info "Instance created. External IP: $IP"

# gcloud generates and registers the keypair on first use, so the first SSH
# can fail while the key propagates. Retry rather than making the human do it.
log_step "Waiting for SSH"
for i in $(seq 1 30); do
    if vm_ssh "true" >/dev/null 2>&1; then
        log_info "SSH is up"
        break
    fi
    [ "$i" -eq 30 ] && die "SSH did not come up after 5 minutes. Check: gcloud compute instances get-serial-port-output $RD_INSTANCE_NAME --zone $RD_ZONE --project $RD_PROJECT"
    printf '.'
    sleep 10
done
echo

log_step "Waiting for bootstrap (docker install + repo clone)"
log_info "Live log: ./ssh.sh --vm tail -f /var/log/dembrane-bootstrap.log"
for i in $(seq 1 60); do
    if vm_ssh "test -f /var/lib/dembrane-bootstrap-done" >/dev/null 2>&1; then
        log_info "Bootstrap complete"
        break
    fi
    [ "$i" -eq 60 ] && die "Bootstrap did not finish after 10 minutes. Inspect /var/log/dembrane-bootstrap.log on the VM."
    printf '.'
    sleep 10
done
echo

# A private repo clone fails inside the startup script, which has no git
# credentials. Surface that clearly instead of letting up.sh fail later.
if ! vm_ssh "test -d '$RD_REPO_DIR/.git'" >/dev/null 2>&1; then
    log_warn "The repo was not cloned (likely a private repo with no credentials on the VM)."
    log_warn "SSH in and clone it manually, then re-run ./up.sh:"
    log_warn "  ./ssh.sh --vm"
    log_warn "  gh auth login && git clone $RD_REPO_URL $RD_REPO_DIR"
    exit 1
fi

# A new VM gets a new IP, so an alias from an earlier VM would dial the old one.
"$RD_SCRIPT_DIR/ssh-config.sh"

log_step "Done"
cat <<EOF
  VM:  $RD_INSTANCE_NAME ($RD_MACHINE_TYPE) in $RD_ZONE
  IP:  $IP
  Repo: $RD_REPO_DIR

Next:
  ./up.sh          copy env files up, start the stack, install dependencies

Remember to ./stop.sh when you are done for the day. A stopped VM bills only
for its disk, which is a few dollars a month rather than a few hundred.
EOF
