#!/usr/bin/env bash
# Common helpers. Every script in commands/ sources this file, which in
# turn sources config.sh and the optional local.env override.

set -euo pipefail

# gcloud catches ctrl-c and exits 1 instead of dying from the signal, so bash
# would treat it as an ordinary failure and carry on with the next step.
trap 'exit 130' INT

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RD_COMMANDS_DIR="$RD_SCRIPT_DIR/commands"
# scripts/remote-dev -> scripts -> echo
RD_ECHO_ROOT="$(cd "$RD_SCRIPT_DIR/../.." && pwd)"

# Precedence: explicit env var, then local.env, then the config.sh default.
#
# config.sh gives way to both because it assigns with `: "${VAR:=default}"`,
# but local.env is a generated file of plain assignments, so sourcing it would
# overwrite an env var the caller passed. `RD_ZONE=... ./scripts/remote-dev.sh create`
# would then silently build in the zone local.env remembers. Snapshot the
# exported RD_* vars, source, and put them back.
if [ -f "$RD_SCRIPT_DIR/local.env" ]; then
    RD_ENV_OVERRIDES="$(export -p | grep -E '^(export |declare -x )RD_[A-Za-z0-9_]*=' || true)"
    # shellcheck disable=SC1091
    source "$RD_SCRIPT_DIR/local.env"
    if [ -n "$RD_ENV_OVERRIDES" ]; then
        eval "$RD_ENV_OVERRIDES"
    fi
    unset RD_ENV_OVERRIDES
fi
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/config.sh"

log_info()  { echo -e "\033[0;32m[remote-dev]\033[0m $1"; }
log_warn()  { echo -e "\033[1;33m[remote-dev]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[remote-dev]\033[0m $1" >&2; }
log_step()  { echo -e "\n\033[1;36m==>\033[0m \033[1m$1\033[0m"; }

die() { log_error "$1"; exit 1; }

# Prompt with a default. Reads from the terminal rather than stdin so this
# still behaves if the script is piped.
ask() {
    local prompt="$1" default="${2:-}" answer
    if [ -n "$default" ]; then
        read -r -p "$(echo -e "\033[1;36m?\033[0m $prompt [\033[1m$default\033[0m]: ")" answer </dev/tty
        echo "${answer:-$default}"
    else
        read -r -p "$(echo -e "\033[1;36m?\033[0m $prompt: ")" answer </dev/tty
        echo "$answer"
    fi
}

confirm() {
    local answer
    answer="$(ask "$1 (y/n)" "${2:-y}")"
    [[ "$answer" =~ ^[Yy] ]]
}

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

# Only checks that a credential is on disk. It cannot tell whether that
# credential still refreshes; require_gcloud's live API call does that.
require_auth() {
    command -v gcloud >/dev/null 2>&1 \
        || die "gcloud not found. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

    RD_GCLOUD_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
    [ -n "$RD_GCLOUD_ACCOUNT" ] || die "No active gcloud account. Run: gcloud auth login"
    log_info "Authenticated as $RD_GCLOUD_ACCOUNT"
}

# An expired refresh token fails every API call, so without this the caller
# sees "cannot access project" and concludes the project is gone.
die_reauth() {
    die "gcloud credentials for '${RD_GCLOUD_ACCOUNT:-your account}' have expired.

Renew them, then re-run this script. Naming the account matters: a bare
'gcloud auth login' signs in as whoever the browser is signed in as, and
leaves that account active instead.

  gcloud auth login ${RD_GCLOUD_ACCOUNT:-<account>}

Nothing in GCP has changed. An expired token makes every project and instance
look missing, because the API rejects the call before it looks anything up."
}

# `gcloud auth login` without an account argument logs in as whoever the
# browser happens to be signed in as, and makes that one active. A personal
# account then sees none of the org's projects, which reads as the project
# having vanished. Point at the other credentials already on disk.
account_hint() {
    local others
    others="$(gcloud auth list --format='value(account)' 2>/dev/null \
        | grep -vxF "${RD_GCLOUD_ACCOUNT:-}" || true)"
    [ -n "$others" ] || return 0

    local preferred
    preferred="$(echo "$others" | grep -F "@${RD_ORG_DOMAIN:-}" | head -1 || true)"
    [ -n "$preferred" ] || preferred="$(echo "$others" | head -1)"

    printf '\n%s\n\n  gcloud auth login %s\n' \
        "You are also logged in as: $(echo "$others" | tr '\n' ',' | sed 's/,$//; s/,/, /g')
If '$RD_PROJECT' belongs to one of those, switch to it. That also renews an
expired token, which 'gcloud config set account' on its own does not:" "$preferred"
}

is_reauth_error() {
    case "$1" in
        *"Reauthentication failed"*|*"Reauthentication required"*) return 0 ;;
        *"refreshing your current auth tokens"*|*"invalid_grant"*)  return 0 ;;
        *"credentials are no longer valid"*|*"do not have valid credentials"*) return 0 ;;
        *) return 1 ;;
    esac
}

# RD_PROJECT and RD_ZONE are per-person and have no committed default, so a
# missing value means init has not run rather than a typo somewhere.
require_config() {
    if [ -z "${RD_PROJECT:-}" ] || [ -z "${RD_ZONE:-}" ]; then
        die "Not configured yet. Run: ./scripts/remote-dev.sh init
It will ask which GCP project and zone to use and write them to local.env (gitignored)."
    fi
}

require_gcloud() {
    require_auth
    require_config

    # First live API call of every script, so it is where a stale token, a
    # project pending deletion, and a genuine permissions problem get told
    # apart. They all surface as the same failed describe otherwise.
    local out
    out="$(gcloud projects describe "$RD_PROJECT" --format='value(lifecycleState)' 2>&1)" || {
        is_reauth_error "$out" && die_reauth
        die "'${RD_GCLOUD_ACCOUNT:-your account}' cannot access project '$RD_PROJECT'.
$(account_hint)
Check the project id too. gcloud said:

$out"
    }

    # A deleted project lingers for 30 days before it is purged, and describe
    # still succeeds during that window, so the state has to be read.
    if [ "$out" = "DELETE_REQUESTED" ]; then
        die "Project '$RD_PROJECT' is scheduled for deletion.

GCP keeps it for 30 days, so it can be brought back:

  gcloud projects undelete $RD_PROJECT"
    fi
}

# APIs are not enabled on a fresh project. Enabling is idempotent and takes up
# to a minute the first time, so only call the API when it is actually off.
require_api() {
    local service="$1" label="$2" enabled
    # A failed listing is not proof the API is off, so do not enable on one.
    enabled="$(gc services list --enabled --format='value(config.name)')" \
        || die "Could not list the enabled APIs on '$RD_PROJECT'."
    if echo "$enabled" | grep -qx "$service"; then
        return 0
    fi
    log_warn "$service is not enabled on '$RD_PROJECT'. Enabling now (this can take a minute)."
    gc services enable "$service"
    log_info "$label API enabled"
}

require_compute_api() { require_api compute.googleapis.com "Compute Engine"; }

# Every API the commands above enable, so status can report on each one.
RD_APIS="compute.googleapis.com aiplatform.googleapis.com"

api_metrics_url() {
    echo "https://console.cloud.google.com/apis/api/$1/metrics?project=$RD_PROJECT"
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
    instance_exists || die "Instance '$RD_INSTANCE_NAME' does not exist. Run: ./scripts/remote-dev.sh create"
}

require_running() {
    require_instance
    local status
    status="$(instance_status)"
    [ "$status" = "RUNNING" ] \
        || die "Instance '$RD_INSTANCE_NAME' is $status, not RUNNING. Run: ./scripts/remote-dev.sh start"
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

# Write a single setting into local.env, updating the line if it is already
# there and appending it if not. Scripts that change a setting on GCP call this
# so the next run agrees with reality, rather than leaving local.env to drift.
persist_local_env() {
    local key="$1" value="$2" file="$RD_SCRIPT_DIR/local.env"
    [ -f "$file" ] || return 0
    if grep -q "^$key=" "$file"; then
        # -i.bak then remove: BSD sed requires the suffix, GNU sed accepts it.
        sed -i.bak "s|^$key=.*|$key=\"$value\"|" "$file"
        rm -f "$file.bak"
    else
        echo "$key=\"$value\"" >> "$file"
    fi
    log_info "Set $key=\"$value\" in local.env"
}

# minio is opt-in through docker-compose-s3.yml. The devcontainer points the
# server at it either way, so file uploads fail while it is off.
RD_MINIO_ENABLE_HINT='re-run ./scripts/remote-dev.sh init and answer y to "Run minio?" (or add docker-compose-s3.yml to RD_COMPOSE_FILES in local.env), then ./scripts/remote-dev.sh up --skip-setup'
minio_enabled() {
    case " $RD_COMPOSE_FILES " in
        *" docker-compose-s3.yml "*) return 0 ;;
        *) return 1 ;;
    esac
}

# The server hands the browser presigned URLs built from STORAGE_S3_ENDPOINT,
# which is http://minio:9000 inside the compose network. Your browser cannot
# resolve that name, so uploads fail with ERR_NAME_NOT_RESOLVED until you point
# it at the forwarded port.
RD_MINIO_HOSTS_HINT='sudo sh -c '"'"'echo "127.0.0.1 minio  # dembrane remote-dev" >> /etc/hosts'"'"''
minio_host_resolves() {
    grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+minio([[:space:]#]|$)' /etc/hosts 2>/dev/null
}

# Run SQL in the postgres container, printing bare values (-tA). Uses the
# postgres service rather than the devcontainer so it works before setup.sh
# has installed psql.
vm_psql() {
    vm_compose "exec -T postgres psql -U dembrane -d dembrane -v ON_ERROR_STOP=1 -tAc $(printf '%q' "$1")"
}

# Run one of the repo's SQL files in the postgres container. The file is read
# from the VM's checkout and piped in, since the postgres container does not
# mount the repo. PGOPTIONS hides the "already exists, skipping" notices an
# idempotent re-run prints for every object.
vm_psql_file() {
    vm_ssh "cd '$RD_REPO_DIR/echo/.devcontainer' && docker compose $(compose_file_args) exec -T --env PGOPTIONS='-c client_min_messages=warning' postgres psql -U dembrane -d dembrane -v ON_ERROR_STOP=1 --quiet --file - < '$RD_REPO_DIR/echo/$1'"
}

# The SQL-only halves of the Map and analysis schemas, in the order
# docs/database_migrations.md gives (steps 5 and 6). Directus sync cannot create
# the pgvector column or the unique keys, and without them every Map read fails
# with a 503. Both are idempotent.
RD_SQL_MIGRATIONS="directus/migrations/add_map_vectors.sql directus/migrations/add_analysis_constraints.sql"

# Partial unique indexes from docs/database_migrations.md. directus-sync does
# not manage them, and the invite race fix relies on them.
RD_MEMBERSHIP_INDEXES="org_membership_active_org_user_uniq workspace_membership_active_ws_user_uniq"
RD_MEMBERSHIP_INDEXES_SQL="
SET client_min_messages = warning;
CREATE UNIQUE INDEX IF NOT EXISTS org_membership_active_org_user_uniq
    ON org_membership (org_id, user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_membership_active_ws_user_uniq
    ON workspace_membership (workspace_id, user_id) WHERE deleted_at IS NULL;"

# --- Help --------------------------------------------------------------------

# Print a script's own header comment block as its help text, so the
# explanation lives next to the code rather than in a duplicate usage string.
header_help() {
    awk 'NR > 1 && !/^#/ { exit } NR > 1' "$1" | sed 's/^#\{1,\} \{0,1\}//'
}

# Every command calls this first, so `./scripts/remote-dev.sh <command> --help`
# works uniformly.
handle_help() {
    case "${1:-}" in
        -h|--help) header_help "$2"; exit 0 ;;
    esac
}
