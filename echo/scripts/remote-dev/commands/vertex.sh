#!/usr/bin/env bash
# Sets up Vertex AI credentials from your GCP project in server/.env and agent/.env.
#
# Enables the Vertex AI API, creates a service account that can only call it,
# and writes a key for that account as GCP_SA_JSON. It also fills in the model
# groups, embeddings and transcription settings that are not already set. The
# server's LLM router, embeddings and transcription all fall back to
# GCP_SA_JSON, so that one key covers them.
#
# Values you already have are left alone. A key already written by this
# command is reused rather than replaced, so re-running does not add keys to
# the account. A key for some other account stops the run unless you pass
# --new-key.
#
#   ./scripts/remote-dev.sh vertex            # set up, or check what is there
#   ./scripts/remote-dev.sh vertex --new-key  # replace the key, deleting ours
#
# Only local files change. Run sync-env (or up) afterwards to copy them to the
# VM. Nothing here needs the VM, so it works for a laptop devcontainer too.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

NEW_KEY=false
while [ $# -gt 0 ]; do
    case "$1" in
        --new-key) NEW_KEY=true; shift ;;
        *) die "Unknown option: $1" ;;
    esac
done

SERVER_ENV="$RD_ECHO_ROOT/server/.env"
SERVER_SAMPLE="$RD_ECHO_ROOT/server/.env.sample"
AGENT_ENV="$RD_ECHO_ROOT/agent/.env"
AGENT_SAMPLE="$RD_ECHO_ROOT/agent/.env.sample"
SA_EMAIL="$RD_VERTEX_SA_NAME@$RD_PROJECT.iam.gserviceaccount.com"

# The last KEY= line wins, as it does for python-dotenv. Surrounding quotes
# are stripped.
env_get() {
    [ -f "$1" ] || return 0
    awk -v key="$2" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$1" \
        | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

# Replaces every KEY= line, or appends one. The value goes through the
# environment rather than the awk program, so no character in it is special.
env_set() {
    local file="$1" key="$2" tmp
    tmp="$(mktemp)"
    RD_ENV_VALUE="$3" awk -v key="$key" '
        index($0, key "=") == 1 { print key "=" ENVIRON["RD_ENV_VALUE"]; found = 1; next }
        { print }
        END { if (!found) print key "=" ENVIRON["RD_ENV_VALUE"] }
    ' "$file" >"$tmp"
    # cat rather than mv keeps the file's permissions.
    cat "$tmp" >"$file"
    rm -f "$tmp"
}

# Sets KEY only while it is unset or empty, and says which it did.
env_default() {
    local file="$1" key="$2" value="$3"
    if [ -n "$(env_get "$file" "$key")" ]; then
        log_info "  $key already set, left alone"
    else
        env_set "$file" "$key" "$value"
        log_info "  $key set"
    fi
}

# GCP_SA_JSON is accepted as raw JSON or base64-encoded JSON.
sa_json() {
    case "$1" in
        "") ;;
        "{"*) printf '%s' "$1" ;;
        *) printf '%s' "$1" | base64 --decode 2>/dev/null || true ;;
    esac
}

sa_field() {
    sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1
}

log_step "Checking gcloud"
require_gcloud
log_info "Project $RD_PROJECT"

[ -f "$SERVER_ENV" ] || die "No server/.env yet. Create it from the sample first:
  cp echo/server/.env.sample echo/server/.env"
if [ ! -f "$AGENT_ENV" ]; then
    cp "$AGENT_SAMPLE" "$AGENT_ENV"
    log_info "Created agent/.env from agent/.env.sample"
fi

log_step "Looking for an existing key"
# Keys this command wrote earlier, by id, so a re-run can reuse a live one and
# --new-key knows which to delete.
OUR_KEY_IDS=""
REUSE_VALUE=""
LIVE_KEY_IDS="$(gc iam service-accounts keys list --iam-account="$SA_EMAIL" --managed-by=user \
    --format='value(name.basename())' 2>/dev/null || true)"
for file in "$SERVER_ENV" "$AGENT_ENV"; do
    value="$(env_get "$file" GCP_SA_JSON)"
    [ -n "$value" ] || continue
    json="$(sa_json "$value")"
    email="$(echo "$json" | sa_field client_email)"
    key_id="$(echo "$json" | sa_field private_key_id)"
    name="${file#"$RD_ECHO_ROOT"/}"
    if [ "$email" != "$SA_EMAIL" ]; then
        log_warn "$name has a key for ${email:-an account that could not be read}"
        if [ "$file" = "$SERVER_ENV" ] && [ "$NEW_KEY" = false ]; then
            die "Leaving server/.env as it is, since that key is not one this command made.
To replace it with a key for $SA_EMAIL, re-run with --new-key."
        fi
        continue
    fi
    OUR_KEY_IDS="$OUR_KEY_IDS $key_id"
    if [ -n "$key_id" ] && echo "$LIVE_KEY_IDS" | grep -qxF "$key_id"; then
        log_info "$name has a live key for $SA_EMAIL"
        REUSE_VALUE="$value"
    else
        log_warn "$name has a key for $SA_EMAIL that no longer exists"
    fi
done

log_step "Vertex AI API"
require_api aiplatform.googleapis.com "Vertex AI"

log_step "Service account"
if gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
    log_info "$SA_EMAIL already exists"
else
    gc iam service-accounts create "$RD_VERTEX_SA_NAME" \
        --display-name="dembrane dev Vertex AI" \
        --description="Calls Vertex AI for the dembrane dev stack. Made by remote-dev vertex for $RD_GCLOUD_ACCOUNT."
    log_info "Created $SA_EMAIL"
fi

# Idempotent. A just-created account can take a few seconds to be visible to
# IAM, and the binding fails until it is, so retry.
for i in $(seq 1 6); do
    if BIND_OUT="$(gc projects add-iam-policy-binding "$RD_PROJECT" \
        --member="serviceAccount:$SA_EMAIL" --role=roles/aiplatform.user \
        --condition=None --quiet 2>&1)"; then
        log_info "$SA_EMAIL has roles/aiplatform.user, and no other role from this command"
        break
    fi
    [ "$i" -eq 6 ] && die "Could not grant roles/aiplatform.user to $SA_EMAIL. gcloud said:

$BIND_OUT"
    sleep 10
done

log_step "Key"
if [ -n "$REUSE_VALUE" ] && [ "$NEW_KEY" = false ]; then
    KEY_VALUE="$REUSE_VALUE"
    log_info "Reusing the existing key. Pass --new-key to replace it."
else
    KEY_FILE="$(mktemp)"
    trap 'rm -f "$KEY_FILE"' EXIT
    chmod 600 "$KEY_FILE"
    gc iam service-accounts keys create "$KEY_FILE" --iam-account="$SA_EMAIL" \
        || die "Could not create a key. If an org policy blocks key creation
(iam.disableServiceAccountKeyCreation), ask an org admin for an exception on '$RD_PROJECT'."
    # GNU base64 wraps its output, which would split the .env line.
    KEY_VALUE="$(base64 <"$KEY_FILE" | tr -d '\n')"
    NEW_KEY_ID="$(sa_field private_key_id <"$KEY_FILE")"
    log_info "Created key $NEW_KEY_ID"
fi

log_step "Writing server/.env"
env_set "$SERVER_ENV" GCP_SA_JSON "$KEY_VALUE"
log_info "  GCP_SA_JSON set"
env_default "$SERVER_ENV" TRANSCRIPTION_PROVIDER "Dembrane-26-07"

# Model names and regions come from the sample, so they follow it when it is
# updated. TEXT_FAST borrows the fast Gemini model: the sample points it at
# Claude on Vertex, which has to be enabled by hand in each project's Model
# Garden before it answers.
for group in MULTI_MODAL_PRO MULTI_MODAL_FAST TEXT_FAST; do
    source_group="$group"
    [ "$group" = TEXT_FAST ] && source_group=MULTI_MODAL_FAST
    prefix="LLM__${group}__"
    model="$(env_get "$SERVER_ENV" "${prefix}MODEL")"
    if [ -z "$model" ]; then
        env_set "$SERVER_ENV" "${prefix}MODEL" "$(env_get "$SERVER_SAMPLE" "LLM__${source_group}__MODEL")"
        env_set "$SERVER_ENV" "${prefix}VERTEX_LOCATION" "$(env_get "$SERVER_SAMPLE" "LLM__${source_group}__VERTEX_LOCATION")"
        env_set "$SERVER_ENV" "${prefix}VERTEX_PROJECT" "$RD_PROJECT"
        log_info "  ${prefix}MODEL, VERTEX_LOCATION and VERTEX_PROJECT set"
    elif [[ "$model" == vertex_ai/* ]]; then
        env_default "$SERVER_ENV" "${prefix}VERTEX_PROJECT" "$RD_PROJECT"
    else
        log_info "  ${prefix}MODEL is $model, not Vertex, left alone"
    fi
done

if [ -z "$(env_get "$SERVER_ENV" EMBEDDING_MODEL)" ]; then
    env_set "$SERVER_ENV" EMBEDDING_MODEL "$(env_get "$SERVER_SAMPLE" EMBEDDING_MODEL)"
    # The regional host names the region the embeddings run in.
    env_default "$SERVER_ENV" EMBEDDING_BASE_URL "$(env_get "$SERVER_SAMPLE" EMBEDDING_BASE_URL)"
    log_info "  EMBEDDING_MODEL set"
else
    log_info "  EMBEDDING_MODEL already set, left alone"
fi

log_step "Writing agent/.env"
AGENT_VALUE="$(env_get "$AGENT_ENV" GCP_SA_JSON)"
AGENT_EMAIL="$(sa_json "$AGENT_VALUE" | sa_field client_email)"
if [ -z "$AGENT_VALUE" ] || [ "$AGENT_EMAIL" = "$SA_EMAIL" ] || [ "$NEW_KEY" = true ]; then
    env_set "$AGENT_ENV" GCP_SA_JSON "$KEY_VALUE"
    log_info "  GCP_SA_JSON set"
else
    log_warn "  GCP_SA_JSON is a key for $AGENT_EMAIL, left alone. --new-key replaces it."
fi
env_default "$AGENT_ENV" VERTEX_PROJECT "$RD_PROJECT"
if [ -n "$(env_get "$AGENT_ENV" VERTEX_CREDENTIALS)" ]; then
    log_warn "  VERTEX_CREDENTIALS is set, and the agent prefers it over GCP_SA_JSON."
fi

# Only once the new key is written everywhere, so a failure above leaves the
# old one working.
if [ -n "${NEW_KEY_ID:-}" ]; then
    for key_id in $OUR_KEY_IDS; do
        [ "$key_id" != "$NEW_KEY_ID" ] || continue
        echo "$LIVE_KEY_IDS" | grep -qxF "$key_id" || continue
        gc iam service-accounts keys delete "$key_id" --iam-account="$SA_EMAIL" --quiet
        log_info "Deleted the replaced key $key_id"
    done
fi

log_step "Done"
cat <<EOF
  Service account: $SA_EMAIL
  Written to:      server/.env, agent/.env (both gitignored)

A new IAM grant can take a few minutes to apply, so the first Vertex calls may
answer 403 for a while.

Next:
  ./scripts/remote-dev.sh up        copy the .env files to the VM and restart the stack
  ./scripts/remote-dev.sh sync-env  or just copy them, then restart mprocs and the agent
EOF
