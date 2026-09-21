#!/usr/bin/env bash
# First-run setup. Asks which GCP org, project and zone to use, then writes
# them to local.env (gitignored) so the other scripts can run unattended.
#
# Re-running is safe: current values are offered as defaults, so you can press
# enter through the parts you do not want to change.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

LOCAL_ENV="$RD_SCRIPT_DIR/local.env"

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

# The zone that matters is the one nearest you, since SSH latency dominates
# how a remote editor feels. Guess from the machine's timezone, which is a
# decent proxy and always overridable.
suggest_zone() {
    local tz
    tz="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"
    [ -n "$tz" ] || tz="$(date +%Z)"
    case "$tz" in
        America/Toronto|America/Montreal|America/New_York|EST|EDT) echo "northamerica-northeast2-a" ;;
        America/Vancouver|America/Los_Angeles|PST|PDT)             echo "us-west1-b" ;;
        America/Chicago|America/Winnipeg|CST|CDT)                  echo "us-central1-a" ;;
        America/Denver|MST|MDT)                                    echo "us-west3-a" ;;
        Europe/Amsterdam|Europe/Berlin|Europe/Paris|CET|CEST)      echo "europe-west4-a" ;;
        Europe/London|GMT|BST)                                     echo "europe-west2-a" ;;
        *)                                                         echo "us-central1-a" ;;
    esac
}

log_step "Checking gcloud"
require_auth

log_step "Organization"
echo "Organizations your account can see:"
gcloud organizations list 2>/dev/null | sed 's/^/  /' || log_warn "  (none listed)"
echo
echo "dembrane contributors should keep the default. Override it if you are"
echo "running this from your own unaffiliated account."
ORG_DOMAIN="$(ask "Organization domain" "$RD_ORG_DOMAIN")"
ORG_ID="$(gcloud organizations list --format='value(ID)' --filter="displayName=$ORG_DOMAIN" 2>/dev/null | head -1)"
if [ -z "$ORG_ID" ]; then
    log_warn "Could not resolve an org id for '$ORG_DOMAIN'. Continuing without one; it is only used to filter the project list."
    ORG_ID="$RD_ORG_ID"
else
    log_info "Resolved $ORG_DOMAIN to org id $ORG_ID"
fi

log_step "Project"
echo "Each person runs their own sandbox project rather than sharing one, so"
echo "the VM, its disk and its billing stay yours alone."
echo
echo "Projects your account can see:"
gcloud projects list --format='table(projectId,name,projectNumber)' 2>/dev/null | sed 's/^/  /' \
    || log_warn "  (none listed)"
echo
PROJECT="$(ask "Project id" "${RD_PROJECT:-}")"
[ -n "$PROJECT" ] || die "A project id is required."

gcloud projects describe "$PROJECT" >/dev/null 2>&1 \
    || die "Cannot access project '$PROJECT'. Check the id, or create it first:
  gcloud projects create $PROJECT --organization=$ORG_ID"

# A project without billing will accept the create call and then fail on quota
# in a way that is hard to read, so check it up front.
if command -v gcloud >/dev/null && gcloud billing projects describe "$PROJECT" >/dev/null 2>&1; then
    if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
        log_warn "Billing is NOT enabled on '$PROJECT'. Compute Engine will refuse to create instances."
        log_warn "Link a billing account: gcloud billing projects link $PROJECT --billing-account=<ACCOUNT_ID>"
        confirm "Continue anyway?" "n" || exit 1
    else
        log_info "Billing is enabled"
    fi
else
    log_warn "Could not read billing status (this needs the Cloud Billing API and billing.viewer). Skipping the check."
fi

log_step "Zone"
echo "Pick the zone closest to you. SSH round-trip time is the single biggest"
echo "factor in how the remote editor feels, and it has nothing to do with"
echo "where production runs."
ZONE="$(ask "Zone" "${RD_ZONE:-$(suggest_zone)}")"

log_step "Machine size"
echo "Starting small is the cheap default. Machine type is not baked into the"
echo "disk, so ./resize.sh moves you up a size in about a minute later."
MACHINE="$(ask "Machine type" "$RD_MACHINE_TYPE")"

log_step "Instance name"
INSTANCE="$(ask "Instance name" "$RD_INSTANCE_NAME")"

log_step "Writing local.env"
cat > "$LOCAL_ENV" <<EOF
# Written by ./init.sh on $(date -u '+%Y-%m-%d %H:%M UTC'). Gitignored.
#
# Per-person settings for the remote dev VM. Edit freely, or re-run ./init.sh
# to regenerate. Team-wide defaults live in config.sh; anything you set here
# overrides them, and an explicit env var overrides both.

RD_PROJECT="$PROJECT"
RD_ZONE="$ZONE"
RD_MACHINE_TYPE="$MACHINE"
RD_INSTANCE_NAME="$INSTANCE"
RD_ORG_DOMAIN="$ORG_DOMAIN"
RD_ORG_ID="$ORG_ID"
EOF

log_info "Wrote $LOCAL_ENV"
echo
cat "$LOCAL_ENV" | grep -v '^#' | grep -v '^$' | sed 's/^/  /'

log_step "Next"
cat <<EOF
  ./create.sh      create the VM, install docker, clone the repo
  ./up.sh          bring the stack up and install dependencies
  ./ssh-config.sh  add the SSH host entries Zed connects through

Or run all three at once:
  ./create.sh && ./up.sh && ./ssh-config.sh
EOF
