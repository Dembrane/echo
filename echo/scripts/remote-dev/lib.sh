#!/usr/bin/env bash
# Common helpers. Every script in this directory sources this file, which in
# turn sources config.sh and the optional local.env override.

set -euo pipefail

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/remote-dev -> scripts -> echo
RD_ECHO_ROOT="$(cd "$RD_SCRIPT_DIR/../.." && pwd)"

# local.env wins over config.sh defaults but loses to explicit env vars,
# because config.sh uses `: "${VAR:=default}"` assignment.
if [ -f "$RD_SCRIPT_DIR/local.env" ]; then
    # shellcheck disable=SC1091
    source "$RD_SCRIPT_DIR/local.env"
fi
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/config.sh"

log_info()  { echo -e "\033[0;32m[remote-dev]\033[0m $1"; }
log_warn()  { echo -e "\033[1;33m[remote-dev]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[remote-dev]\033[0m $1" >&2; }
log_step()  { echo -e "\n\033[1;36m==>\033[0m \033[1m$1\033[0m"; }

die() { log_error "$1"; exit 1; }

# Every gcloud call goes through these wrappers so the pinned project and zone
# can never be forgotten at a call site.
gc() { gcloud --project "$RD_PROJECT" "$@"; }

# For compute subcommands that take no `--` passthrough. The zone lands at the
# end, which is fine here but would be wrong for ssh/scp: anything after `--`
# is handed to the real ssh binary, so a trailing --zone would be passed
# through as a bogus ssh argument instead of being read by gcloud.
gc_zone() { gcloud --project "$RD_PROJECT" compute "$@" --zone "$RD_ZONE"; }

# ssh and scp put --zone up front, before any caller-supplied args, so callers
# are free to use `--` for real ssh flags such as -L and -N.
gc_ssh() { gcloud --project "$RD_PROJECT" compute ssh "$RD_INSTANCE_NAME" --zone "$RD_ZONE" "$@"; }
gc_scp() { gcloud --project "$RD_PROJECT" compute scp --zone "$RD_ZONE" "$@"; }

require_auth() {
    command -v gcloud >/dev/null 2>&1 \
        || die "gcloud not found. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

    local account
    account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
    [ -n "$account" ] || die "No active gcloud account. Run: gcloud auth login"
    log_info "Authenticated as $account"
}

# RD_PROJECT and RD_ZONE are per-person and have no committed default, so a
# missing value means init has not run rather than a typo somewhere.
require_config() {
    if [ -z "${RD_PROJECT:-}" ] || [ -z "${RD_ZONE:-}" ]; then
        die "Not configured yet. Run: ./init.sh
It will ask which GCP project and zone to use and write them to local.env (gitignored)."
    fi
}

require_gcloud() {
    require_auth
    require_config
    gcloud projects describe "$RD_PROJECT" >/dev/null 2>&1 \
        || die "Cannot access project '$RD_PROJECT'. Check the project id and that your account has access."
}

# Compute is not enabled on a fresh project. Enabling is idempotent and takes
# up to a minute the first time, so only call the API when it is actually off.
require_compute_api() {
    if gc services list --enabled --format='value(config.name)' 2>/dev/null | grep -qx 'compute.googleapis.com'; then
        return 0
    fi
    log_warn "compute.googleapis.com is not enabled on '$RD_PROJECT'. Enabling now (this can take a minute)."
    gc services enable compute.googleapis.com
    log_info "Compute Engine API enabled"
}

instance_exists() {
    gc_zone instances describe "$RD_INSTANCE_NAME" --format='value(name)' >/dev/null 2>&1
}

instance_status() {
    gc_zone instances describe "$RD_INSTANCE_NAME" --format='value(status)' 2>/dev/null || echo "NOT_FOUND"
}

instance_ip() {
    gc_zone instances describe "$RD_INSTANCE_NAME" \
        --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null
}

require_instance() {
    instance_exists || die "Instance '$RD_INSTANCE_NAME' does not exist. Run: ./create.sh"
}

require_running() {
    require_instance
    local status
    status="$(instance_status)"
    [ "$status" = "RUNNING" ] \
        || die "Instance '$RD_INSTANCE_NAME' is $status, not RUNNING. Run: ./start.sh"
}

# Run a command on the VM over gcloud's SSH wrapper, which manages the
# ~/.ssh/google_compute_engine keypair and pushes the public key into project
# metadata for us. No manual key handling needed.
vm_ssh() {
    gc_ssh --command "$*"
}

# Interactive shell on the VM (no --command), plus any extra ssh args.
vm_ssh_interactive() {
    gc_ssh "$@"
}

# Run a command inside the devcontainer service via the VM.
# `bash -lc` is required: the devcontainer puts fnm, node, pnpm and uv on PATH
# through ~/.bashrc, so a non-login shell will not find them.
container_exec() {
    local inner="$1"
    vm_ssh "cd '$RD_REPO_DIR/echo/.devcontainer' && docker compose exec -T devcontainer bash -lc $(printf '%q' "$inner")"
}

compose_file_args() {
    local args=""
    local f
    for f in $RD_COMPOSE_FILES; do
        args="$args -f $f"
    done
    echo "$args"
}

# Run `docker compose ...` on the VM from the .devcontainer directory, with
# every configured compose file applied.
vm_compose() {
    vm_ssh "cd '$RD_REPO_DIR/echo/.devcontainer' && docker compose $(compose_file_args) $*"
}

# Run `docker compose ...` against every container in the project, whichever
# compose files started it. vm_compose only sees the services in
# RD_COMPOSE_FILES, so it misses minio when that was started by hand or
# RD_COMPOSE_FILES changed since. compose names the project after the
# .devcontainer directory.
vm_compose_project() {
    vm_ssh "docker compose --project-name devcontainer $*"
}

# minio is opt-in through docker-compose-s3.yml. The devcontainer points the
# server at it either way, so file uploads fail while it is off.
RD_MINIO_ENABLE_HINT='re-run ./init.sh and answer y to "Run minio?" (or add docker-compose-s3.yml to RD_COMPOSE_FILES in local.env), then ./up.sh --skip-setup'
minio_enabled() {
    case " $RD_COMPOSE_FILES " in
        *" docker-compose-s3.yml "*) return 0 ;;
        *) return 1 ;;
    esac
}

# Run SQL in the postgres container, printing bare values (-tA). Uses the
# postgres service rather than the devcontainer so it works before setup.sh
# has installed psql.
vm_psql() {
    vm_compose "exec -T postgres psql -U dembrane -d dembrane -v ON_ERROR_STOP=1 -tAc $(printf '%q' "$1")"
}

# Partial unique indexes from docs/database_migrations.md. directus-sync does
# not manage them, and the invite race fix relies on them.
RD_MEMBERSHIP_INDEXES="org_membership_active_org_user_uniq workspace_membership_active_ws_user_uniq"
RD_MEMBERSHIP_INDEXES_SQL="
SET client_min_messages = warning;
CREATE UNIQUE INDEX IF NOT EXISTS org_membership_active_org_user_uniq
    ON org_membership (org_id, user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_membership_active_ws_user_uniq
    ON workspace_membership (workspace_id, user_id) WHERE deleted_at IS NULL;"
