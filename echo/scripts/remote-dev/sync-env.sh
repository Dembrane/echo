#!/usr/bin/env bash
# Copies the gitignored .env files from your laptop up to the VM.
#
# These cannot be cloned with the repo because they hold secrets and are in
# .gitignore. directus/.env is required by docker-compose.yml (`env_file:`),
# so the stack will not start without it.
#
# Run this again any time you change a local .env.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud
require_running

COPIED=0
MISSING=()

for rel in $RD_ENV_FILES; do
    local_path="$RD_ECHO_ROOT/$rel"
    remote_path="$RD_REPO_DIR/echo/$rel"

    if [ ! -f "$local_path" ]; then
        MISSING+=("$rel")
        continue
    fi

    log_info "Copying $rel"
    vm_ssh "mkdir -p '$(dirname "$remote_path")'"
    gc_scp "$local_path" "$RD_INSTANCE_NAME:$remote_path" >/dev/null
    COPIED=$((COPIED + 1))
done

log_info "Copied $COPIED file(s)"

if [ ${#MISSING[@]} -gt 0 ]; then
    echo
    for rel in "${MISSING[@]}"; do
        if [ "$rel" = "directus/.env" ]; then
            log_error "Missing $rel. docker-compose.yml requires it and the stack will not start."
            log_error "Create it from the sample first: cp echo/directus/.env.sample echo/directus/.env"
        else
            log_warn "Missing $rel (optional, skipped)"
        fi
    done
fi
