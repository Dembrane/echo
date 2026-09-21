#!/usr/bin/env bash
# Brings the whole stack up on the VM:
#   1. copies .env files up
#   2. docker compose up -d (postgres, valkey, directus, agent, devcontainer)
#   3. runs the devcontainer's own setup.sh (node, pnpm, uv, deps, sshd)
#   4. installs your public key into the devcontainer so Zed can connect
#
# Safe to re-run. setup.sh is idempotent and compose only recreates what
# changed, so this doubles as the "bring it back after a reboot" command.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

SKIP_SETUP=false
[ "${1:-}" = "--skip-setup" ] && SKIP_SETUP=true

require_gcloud
require_running

log_step "Syncing env files"
"$RD_SCRIPT_DIR/sync-env.sh"

log_step "Starting containers"
log_info "The first run builds the directus, agent and server images. Expect 5 to 15 minutes."
vm_compose "up -d --build"

log_step "Container state"
vm_compose "ps"

if [ "$SKIP_SETUP" = false ]; then
    log_step "Running devcontainer setup.sh"
    log_info "Installs fnm, node 22, pnpm, uv, python 3.11, psql, sshd, then pnpm install and uv sync."
    log_info "This is the slow part on a first run. Ten minutes or so is normal."
    # devcontainer.json runs this as postCreateCommand, but compose alone does
    # not honour devcontainer lifecycle hooks, so invoke it explicitly.
    container_exec "cd /workspaces/echo && chmod +x ./.devcontainer/setup.sh && ./.devcontainer/setup.sh"
else
    log_warn "Skipping setup.sh (--skip-setup)"
fi

log_step "Installing your SSH key into the devcontainer"
# setup.sh starts sshd inside the container with a default root password. Key
# auth is what Zed should use, so push the same key gcloud already manages.
PUBKEY_FILE="$HOME/.ssh/google_compute_engine.pub"
if [ ! -f "$PUBKEY_FILE" ]; then
    log_warn "No $PUBKEY_FILE yet. Falling back to id_ed25519.pub / id_rsa.pub."
    PUBKEY_FILE="$(ls "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" 2>/dev/null | head -1 || true)"
fi

if [ -n "$PUBKEY_FILE" ] && [ -f "$PUBKEY_FILE" ]; then
    PUBKEY="$(cat "$PUBKEY_FILE")"
    container_exec "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && grep -qxF '$PUBKEY' /root/.ssh/authorized_keys || echo '$PUBKEY' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"
    log_info "Installed $(basename "$PUBKEY_FILE") into the devcontainer's authorized_keys"
else
    log_warn "No public key found. Zed will have to fall back to the default password (root / dembrane)."
fi

log_step "Ready"
cat <<EOF
  ./ssh-config.sh   write the SSH host entries (run once, and after each start)
  ./tunnel.sh       forward ports to localhost so your browser can reach the app
  ./ssh.sh          shell into the devcontainer

Then in Zed: cmd-shift-P, "projects: open remote", host "$RD_SSH_CONTAINER_HOST",
and open /workspaces/echo.

Start the dev processes from inside the container with mprocs:
  ./ssh.sh
  cd /workspaces/echo && mprocs
EOF
