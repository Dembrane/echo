#!/usr/bin/env bash
# Runs once on the VM as root, as the GCE startup script. Installs docker and
# git, then clones the repo as the login user.
#
# Values come from instance metadata rather than being templated in, so the
# same file works unmodified for anyone and shows up verbatim in the console.
#
# Progress: tail -f /var/log/dembrane-bootstrap.log
# Done marker: /var/lib/dembrane-bootstrap-done

set -euo pipefail

exec > >(tee -a /var/log/dembrane-bootstrap.log) 2>&1
echo "=== dembrane bootstrap starting at $(date -u) ==="

DONE_MARKER=/var/lib/dembrane-bootstrap-done

meta() {
    curl -fsS -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

REPO_URL="$(meta dembrane-repo-url)"
REPO_DIR="$(meta dembrane-repo-dir)"
TARGET_USER="$(meta dembrane-user)"
# Empty means the remote's default branch.
REPO_BRANCH="$(meta dembrane-repo-branch)"

echo "repo-url=$REPO_URL repo-dir=$REPO_DIR repo-branch=${REPO_BRANCH:-default} user=$TARGET_USER"

if [ -f "$DONE_MARKER" ]; then
    echo "Bootstrap already completed. Nothing to do."
    exit 0
fi

echo "--- Installing base packages ---"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git rsync

echo "--- Installing Docker Engine ---"
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
    echo "Docker already present: $(docker --version)"
fi

systemctl enable --now docker

# The login user needs to run docker without sudo, because every helper script
# here shells in as that user and calls `docker compose`.
if [ -n "$TARGET_USER" ] && id "$TARGET_USER" >/dev/null 2>&1; then
    usermod -aG docker "$TARGET_USER"
    echo "Added $TARGET_USER to the docker group"
fi

echo "--- Cloning repo ---"
if [ -n "$REPO_URL" ] && [ -n "$REPO_DIR" ] && [ -n "$TARGET_USER" ]; then
    if [ -d "$REPO_DIR/.git" ]; then
        echo "Repo already present at $REPO_DIR"
    else
        # A public clone needs no credentials. If the repo is private the clone
        # fails here and create.sh tells you to push a deploy key or use
        # `gh auth setup-git` over SSH; the rest of the bootstrap still stands.
        sudo -u "$TARGET_USER" git clone --filter=blob:none ${REPO_BRANCH:+--branch "$REPO_BRANCH"} "$REPO_URL" "$REPO_DIR" \
            || echo "WARNING: clone failed. Authenticate on the VM and clone manually into $REPO_DIR"
    fi
fi

# Docker builds for this stack are memory hungry and the small default VM has
# no swap. A few GB of swap turns an OOM-killed build into a slow one.
if ! swapon --show | grep -q '/swapfile'; then
    echo "--- Adding 4G swap ---"
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

touch "$DONE_MARKER"
echo "=== dembrane bootstrap finished at $(date -u) ==="
