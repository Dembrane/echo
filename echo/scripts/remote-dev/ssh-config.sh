#!/usr/bin/env bash
# Writes two SSH host entries into ~/.ssh/config, inside a managed block that
# this script owns and rewrites in place. Your own entries are never touched.
#
#   dembrane-devbox       the VM itself
#   dembrane-devcontainer the devcontainer, reached by jumping through the VM
#
# Zed should connect to the second one. That is what puts the language servers
# (ruff, ty, biome) and the toolchain (uv, pnpm, node) in the same place as the
# code, which is the whole point of using the devcontainer at all.
#
# The VM's external IP is ephemeral and changes on every start, so ./start.sh
# re-runs this automatically.
#
#   ./ssh-config.sh           write or refresh the block
#   ./ssh-config.sh --remove  delete the block

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

SSH_CONFIG="$HOME/.ssh/config"
BEGIN_MARKER="# BEGIN dembrane remote-dev (managed by echo/scripts/remote-dev/ssh-config.sh)"
END_MARKER="# END dembrane remote-dev"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$SSH_CONFIG"

strip_block() {
    if grep -qF "$BEGIN_MARKER" "$SSH_CONFIG" 2>/dev/null; then
        # awk rather than sed -i, because the markers contain slashes and this
        # keeps the behaviour identical on BSD and GNU userlands.
        awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
            $0 == b { skip = 1 }
            !skip   { print }
            $0 == e { skip = 0 }
        ' "$SSH_CONFIG" > "$SSH_CONFIG.tmp"
        mv "$SSH_CONFIG.tmp" "$SSH_CONFIG"
    fi
}

if [ "${1:-}" = "--remove" ]; then
    strip_block
    log_info "Removed the managed block from $SSH_CONFIG"
    exit 0
fi

require_gcloud
require_running

IP="$(instance_ip)"
[ -n "$IP" ] || die "Could not determine the instance's external IP."

KEY="$HOME/.ssh/google_compute_engine"
[ -f "$KEY" ] || log_warn "$KEY does not exist yet. Run ./ssh.sh --vm once so gcloud generates it."

strip_block

cat >> "$SSH_CONFIG" <<EOF
$BEGIN_MARKER
# Regenerated $(date -u '+%Y-%m-%d %H:%M UTC'). Edits inside this block are lost.

# The VM itself. Useful for docker commands and reading bootstrap logs.
Host $RD_SSH_HOST
    HostName $IP
    User $RD_REMOTE_USER
    IdentityFile $KEY
    IdentitiesOnly yes
    # The VM is rebuilt and its IP recycled often enough that a pinned host key
    # would mean clearing known_hosts constantly. The jump host is reached over
    # an IP that only this project controls, so the tradeoff is acceptable here
    # and would not be on a long-lived server.
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR

# The devcontainer. Connect Zed to THIS one.
# Its sshd listens on the VM's port $RD_CONTAINER_SSH_PORT, which is never
# opened in the GCP firewall. ProxyJump reaches it through the VM's own sshd,
# so the container is only ever exposed to someone who can already SSH to the VM.
Host $RD_SSH_CONTAINER_HOST
    HostName localhost
    Port $RD_CONTAINER_SSH_PORT
    User root
    ProxyJump $RD_SSH_HOST
    IdentityFile $KEY
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
    # Keeps the long-lived editor connection from dropping on an idle NAT.
    ServerAliveInterval 30
    ServerAliveCountMax 6
$END_MARKER
EOF

chmod 600 "$SSH_CONFIG"
log_info "Wrote host entries to $SSH_CONFIG (VM at $IP)"

log_step "Verifying"
if ssh -o ConnectTimeout=15 -o BatchMode=yes "$RD_SSH_CONTAINER_HOST" "echo ok" 2>/dev/null | grep -q ok; then
    log_info "ssh $RD_SSH_CONTAINER_HOST works"
else
    log_warn "Could not reach $RD_SSH_CONTAINER_HOST yet."
    log_warn "The devcontainer's sshd is started by setup.sh, so run ./up.sh if you have not."
fi

log_step "Zed"
cat <<EOF
  cmd-shift-P, "projects: open remote"
  Add host:  $RD_SSH_CONTAINER_HOST
  Open path: /workspaces/echo

The repo's .zed/settings.json (ruff, ty, biome) applies automatically once the
project opens, because those language servers now run inside the container
alongside the code.
EOF
