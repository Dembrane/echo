#!/usr/bin/env bash
# Brings the whole stack up on the VM and installs dependencies.
#
# In order:
#   1. copies .env files up
#   2. docker compose up -d (postgres, valkey, directus, agent, devcontainer)
#   3. runs the devcontainer's own setup.sh (node, pnpm, uv, deps, sshd)
#   4. pushes the directus schema and the membership indexes
#   5. installs your public key into the devcontainer so Zed can connect
#
# Safe to re-run. setup.sh is idempotent, compose only recreates what changed,
# and the schema push only applies differences, so this doubles as the "bring
# it back after a reboot" command.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

SKIP_SETUP=false
[ "${1:-}" = "--skip-setup" ] && SKIP_SETUP=true

require_gcloud
require_running

# The VM has its own checkout, so a compose file that exists only on your
# branch is missing there, and docker's "no such file" does not say why.
MISSING="$(vm_ssh "cd '$RD_REPO_DIR/echo/.devcontainer' && for f in $RD_COMPOSE_FILES; do [ -f \"\$f\" ] || echo \"\$f\"; done" || true)"
if [ -n "$MISSING" ]; then
    VM_BRANCH="$(vm_ssh "git -C '$RD_REPO_DIR' rev-parse --abbrev-ref HEAD" 2>/dev/null || echo unknown)"
    die "The VM's checkout (on $VM_BRANCH) has no $(echo "$MISSING" | paste -sd, - | sed 's/,/, /g'), which your local.env asks for.
Copy your working tree up with ./scripts/remote-dev.sh sync-code, or push your branch and check it out on the VM."
fi

log_step "Syncing env files"
"$RD_COMMANDS_DIR/sync-env.sh"

log_step "Starting containers"
log_info "The first run builds the directus, agent and server images. Expect 5 to 15 minutes."
vm_compose "up -d --build"

# Turning minio off only drops docker-compose-s3.yml from RD_COMPOSE_FILES, and
# a service compose no longer knows about is an orphan it leaves running. Remove
# it by name rather than passing --remove-orphans, which would also take out
# anything else started in this project by hand.
if ! minio_enabled; then
    vm_compose_project "rm --stop --force minio" >/dev/null 2>&1 || true
fi

log_step "Container state"
# Project-wide, so a container the configured compose files no longer define
# still shows up instead of silently running.
vm_compose_project "ps"

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

log_step "Applying the directus schema"
# directus boots with only its system tables. The app schema lives in
# directus/sync/ and is otherwise pushed by hand (docs/database_migrations.md).
# A push also removes what the snapshot lacks, so the database follows the
# checked-out branch, older ones included.
container_exec "for _ in \$(seq 60); do curl -sf http://directus:8055/server/ping >/dev/null && exit 0; sleep 2; done; exit 1" \
    || die "directus did not answer within 2 minutes. See: ./scripts/remote-dev.sh ssh --vm, then docker compose logs directus"
# sync.sh logs at debug level, so keep the output only for when it fails.
# Retried because a busy directus answers 503 now and then, and a push is
# idempotent.
container_exec "cd /workspaces/echo/directus && for n in 1 2 3; do ./sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin push >/tmp/directus-sync.log 2>&1 && exit 0; echo \"Push attempt \$n failed.\"; sleep 5; done; tail -40 /tmp/directus-sync.log; exit 1" \
    || die "Schema push failed. Full log in the devcontainer at /tmp/directus-sync.log"
vm_psql "$RD_MEMBERSHIP_INDEXES_SQL" >/dev/null \
    || die "Could not create the membership indexes."
log_info "Schema and indexes are current. Restart the server in mprocs if it is already running."

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
if ! minio_enabled; then
    log_warn "minio is off, so file uploads and recordings fail. Enable with: $RD_MINIO_ENABLE_HINT"
fi
cat <<EOF
  ./scripts/remote-dev.sh ssh-config  refresh the SSH host entries, if the VM was started from the console
  ./scripts/remote-dev.sh tunnel      forward ports to localhost so your browser can reach the app
  ./scripts/remote-dev.sh ssh         shell into the devcontainer

Then in Zed: cmd-shift-P, "projects: open remote", host "$RD_SSH_CONTAINER_HOST",
and open /workspaces/echo.

Start the dev processes from inside the container with mprocs:
  ./scripts/remote-dev.sh ssh
  cd /workspaces/echo && mprocs
EOF
