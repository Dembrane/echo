#!/usr/bin/env bash
# Creates the VM, installs docker, clones the repo and writes the SSH hosts.
#
# Enables the Compute API if needed, makes sure an SSH firewall rule exists,
# boots an Ubuntu instance, and runs bootstrap-vm.sh to install docker and
# clone the repo.
#
# Idempotent. If the instance already exists this reports its state and exits
# without touching it.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

log_step "Preflight"
require_gcloud
require_compute_api
log_info "Project $RD_PROJECT, zone $RD_ZONE"

if instance_exists; then
    log_warn "Instance '$RD_INSTANCE_NAME' already exists (state: $(instance_status))."
    log_info "To start it:   ./scripts/remote-dev.sh start"
    log_info "To replace it: ./scripts/remote-dev.sh destroy && ./scripts/remote-dev.sh create"
    exit 0
fi

# Clone the branch you are on, so the VM has what the stack depends on with a
# clean git status. It has to exist on RD_REPO_URL, which may not be where you
# push: a branch on your fork alone falls back to the default branch, and the
# working-tree sync at the end carries it up instead.
RD_REPO_ROOT="$(cd "$RD_ECHO_ROOT/.." && pwd)"
LOCAL_BRANCH="$(git -C "$RD_REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
CLONE_BRANCH=""
CLONE_SHA=""
if [ -n "$LOCAL_BRANCH" ]; then
    # No prompt: a private RD_REPO_URL would otherwise stop here for a password.
    CLONE_SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$RD_REPO_URL" "refs/heads/$LOCAL_BRANCH" 2>/dev/null | cut -f1 || true)"
fi
if [ -n "$CLONE_SHA" ]; then
    CLONE_BRANCH="$LOCAL_BRANCH"
    log_info "The VM will clone $CLONE_BRANCH"
else
    log_info "${LOCAL_BRANCH:-Your checkout} is not on $RD_REPO_URL, so the VM will clone its default branch"
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
    --metadata="dembrane-repo-url=$RD_REPO_URL,dembrane-repo-dir=$RD_REPO_DIR,dembrane-user=$RD_REMOTE_USER${CLONE_BRANCH:+,dembrane-repo-branch=$CLONE_BRANCH}" \
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
log_info "Live log: ./scripts/remote-dev.sh ssh --vm tail -f /var/log/dembrane-bootstrap.log"
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
    log_warn "SSH in and clone it manually, then re-run ./scripts/remote-dev.sh up:"
    log_warn "  ./scripts/remote-dev.sh ssh --vm"
    log_warn "  gh auth login && git clone $RD_REPO_URL $RD_REPO_DIR"
    exit 1
fi

# A new VM gets a new IP, so an alias from an earlier VM would dial the old one.
"$RD_COMMANDS_DIR/ssh-config.sh"

# Even a clone of your branch lacks unpushed commits and uncommitted edits, and
# up runs whatever the VM has. Only offered now, while the VM has no work of
# its own for the copy to overwrite.
log_step "Your working tree"
DIRTY="$(git -C "$RD_REPO_ROOT" status --porcelain --untracked-files=no)"
if [ -n "$CLONE_BRANCH" ] && [ -z "$DIRTY" ] && [ "$CLONE_SHA" = "$(git -C "$RD_REPO_ROOT" rev-parse HEAD)" ]; then
    log_info "The VM's clone matches your checkout. Nothing to copy."
else
    if [ -n "$CLONE_BRANCH" ]; then
        log_info "The VM cloned $CLONE_BRANCH at ${CLONE_SHA:0:8}, and you are at $(git -C "$RD_REPO_ROOT" rev-parse --short=8 HEAD)."
    else
        log_info "The VM cloned the default branch, and you are on ${LOCAL_BRANCH:-a detached HEAD}."
    fi
    if [ -n "$DIRTY" ]; then
        log_info "These uncommitted changes would be copied too:"
        echo "$DIRTY" | sed 's/^/    /'
    fi
    # Opening /dev/tty, not testing it: the node exists even with no terminal.
    if { : </dev/tty; } 2>/dev/null && confirm "Copy your working tree to the VM?" "y"; then
        "$RD_COMMANDS_DIR/sync-code.sh"
    else
        log_info "Skipped. Copy it later with: ./scripts/remote-dev.sh sync-code"
    fi
fi

log_step "Done"
cat <<EOF
  VM:  $RD_INSTANCE_NAME ($RD_MACHINE_TYPE) in $RD_ZONE
  IP:  $IP
  Repo: $RD_REPO_DIR

Next:
  ./scripts/remote-dev.sh up  copy env files up, start the stack, install dependencies

Remember to ./scripts/remote-dev.sh stop when you are done for the day. A
stopped VM bills only for its disk, which is a few dollars a month rather than
a few hundred.
EOF
