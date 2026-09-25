#!/usr/bin/env bash
# First-run setup: asks for the GCP project, zone and VM size; writes local.env.
#
# Answers go to local.env (gitignored) so the other commands can run unattended.
#
# Re-running is safe: current values are offered as defaults, so you can press
# enter through the parts you do not want to change.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

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
# The first live API call here. Keep stderr so an expired token is named
# instead of shown as an empty list, the same as the project list below.
ORG_LIST="$(gcloud organizations list 2>&1)" || {
    is_reauth_error "$ORG_LIST" && die_reauth
    ORG_LIST=""
}
if [ -n "$ORG_LIST" ]; then echo "$ORG_LIST" | sed 's/^/  /'; else log_warn "  (none listed)"; fi
echo
echo "dembrane contributors should keep the default. Override it if you are"
echo "running this from your own unaffiliated account."
ORG_DOMAIN="$(ask "Organization domain" "$RD_ORG_DOMAIN")"
ORG_ID="$(gcloud organizations list --format='value(ID)' --filter="displayName=$ORG_DOMAIN" 2>/dev/null | head -1 || true)"
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
# An expired token returns no projects, which reads as "my project is gone".
# Keep stderr so that case can be named instead of shown as an empty list.
PROJECT_LIST="$(gcloud projects list --format='table(projectId,name,projectNumber)' 2>&1)" || {
    is_reauth_error "$PROJECT_LIST" && die_reauth
    log_warn "  (could not list projects: $PROJECT_LIST)"
    PROJECT_LIST=""
}
if [ -n "$PROJECT_LIST" ]; then
    echo "$PROJECT_LIST" | sed 's/^/  /'
fi
echo
PROJECT="$(ask "Project id" "${RD_PROJECT:-}")"
[ -n "$PROJECT" ] || die "A project id is required."

PROJECT_STATE="$(gcloud projects describe "$PROJECT" --format='value(lifecycleState)' 2>&1)" || {
    is_reauth_error "$PROJECT_STATE" && die_reauth
    die "Cannot access project '$PROJECT'. Check the id, or create it first:
  gcloud projects create $PROJECT --organization=$ORG_ID"
}
if [ "$PROJECT_STATE" = "DELETE_REQUESTED" ]; then
    die "Project '$PROJECT' is scheduled for deletion. Restore it within 30
days of the request with: gcloud projects undelete $PROJECT"
fi

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

# The helpers in lib.sh read RD_PROJECT, and the machine-type check below needs
# the Compute API on. Enabling here rather than in create.sh means the size
# menu can actually verify its answers instead of guessing.
RD_PROJECT="$PROJECT"
require_compute_api

log_step "Zone"
echo "Pick the zone closest to you. SSH round-trip time is the single biggest"
echo "factor in how the remote editor feels, and it has nothing to do with"
echo "where production runs."
ZONE="$(ask "Zone" "${RD_ZONE:-$(suggest_zone)}")"
# Mirrors the RD_PROJECT assignment above, so the gc_* wrappers below describe
# the instance in the zone just chosen rather than the one local.env remembers.
RD_ZONE="$ZONE"

log_step "Machine size"
cat <<'EOF'
Starting small is the cheap default. Machine type is not baked into the disk,
so ./scripts/remote-dev.sh resize moves you up a size in about a minute without losing anything.

                   vCPU  RAM    approx/mo    notes
  1) e2-standard-2    2    8GB      ~$50      containers only, tight
  2) e2-standard-4    4   16GB     ~$100      recommended starting point
  3) e2-standard-8    8   32GB     ~$200      comfortable with all of mprocs
  4) e2-standard-16  16   64GB     ~$400      heavy builds, rarely needed
  5) other                                    type any GCP machine type

Prices are list price for a VM left running 24/7, and vary by region. Stopping
the VM when you are not using it (./scripts/remote-dev.sh stop) is worth more than picking a
smaller size: an 8-hour workday is roughly a quarter of these numbers.

Sizing for this stack: 5 containers (postgres, valkey, directus, agent, the
devcontainer) idle at around 3GB. Option 1 runs those but leaves little room
for the 7 mprocs processes on top, and image builds will swap. Option 2 is the
honest floor for day-to-day work. Go to option 3 if builds or the three
dramatiq workers start fighting each other.
EOF

# A curated menu beats `gcloud compute machine-types list`, which returns
# several hundred rows and none of the context above. The escape hatch covers
# anything else.
#
# Offer the current size as the default, so a re-run keeps it. config.sh
# defaults to e2-standard-4, which makes 2 the default on a first run. Any
# other type defaults to 5, whose prompt then offers that type.
#
# "Current" means what GCP reports, not what local.env last recorded. A resize
# done from the console, or one that stopped before writing local.env, leaves
# that file stale, and a stale default here silently shrinks the VM the next
# time anyone runs ./scripts/remote-dev.sh create.
LIVE_MACHINE="$( { gc_zone instances describe "$RD_INSTANCE_NAME" \
    --format='value(machineType)' 2>/dev/null || true; } | sed 's|.*/||' )"
if [ -n "$LIVE_MACHINE" ] && [ "$LIVE_MACHINE" != "$RD_MACHINE_TYPE" ]; then
    log_warn "local.env says $RD_MACHINE_TYPE, but '$RD_INSTANCE_NAME' is really $LIVE_MACHINE."
    log_warn "Offering the real size. Press enter to keep it."
    RD_MACHINE_TYPE="$LIVE_MACHINE"
fi

case "$RD_MACHINE_TYPE" in
    e2-standard-2)  CHOICE_DEFAULT=1 ;;
    e2-standard-4)  CHOICE_DEFAULT=2 ;;
    e2-standard-8)  CHOICE_DEFAULT=3 ;;
    e2-standard-16) CHOICE_DEFAULT=4 ;;
    *)              CHOICE_DEFAULT=5 ;;
esac
CHOICE="$(ask "Choose 1-5" "$CHOICE_DEFAULT")"
case "$CHOICE" in
    1) MACHINE="e2-standard-2" ;;
    2) MACHINE="e2-standard-4" ;;
    3) MACHINE="e2-standard-8" ;;
    4) MACHINE="e2-standard-16" ;;
    5) MACHINE="$(ask "Machine type" "$RD_MACHINE_TYPE")" ;;
    # Someone who types a machine type instead of a number meant that.
    e2-*|n2-*|n2d-*|c3-*|c4-*|t2d-*|n1-*|custom-*) MACHINE="$CHOICE" ;;
    *) die "Not a valid choice: $CHOICE" ;;
esac

# Machine families are not available in every zone, and a bad pairing fails at
# create time with a less obvious message than this one.
#
# --quiet and </dev/null matter here: if the Compute API were somehow still
# off, gcloud would prompt to enable it, and with output redirected that prompt
# is invisible while it waits on stdin.
SPEC="$(gcloud compute machine-types describe "$MACHINE" \
    --zone "$ZONE" --project "$PROJECT" --quiet \
    --format='value(guestCpus,memoryMb)' 2>/dev/null </dev/null || true)"

if [ -n "$SPEC" ]; then
    CPUS="$(echo "$SPEC" | awk '{print $1}')"
    RAM_GB="$(echo "$SPEC" | awk '{printf "%.0f", $2/1024}')"
    log_info "$MACHINE available in $ZONE: ${CPUS} vCPU, ${RAM_GB}GB RAM"
else
    log_warn "Could not confirm '$MACHINE' is available in $ZONE."
    log_warn "See what is: gcloud compute machine-types list --zones=$ZONE --project=$PROJECT"
    confirm "Use it anyway?" "n" || die "Stopped. Re-run ./scripts/remote-dev.sh init to pick another size."
fi

log_step "Instance name"
INSTANCE="$(ask "Instance name" "$RD_INSTANCE_NAME")"

# Not prompted for: disks only ever grow, and `resize --disk` is where that
# happens. This just carries the size forward, preferring the real disk over
# local.env for the same reason the machine type does, so writing local.env
# cannot quietly undo a resize.
LIVE_DISK="$(gc compute disks describe "$RD_INSTANCE_NAME" --zone "$RD_ZONE" \
    --format='value(sizeGb)' 2>/dev/null || true)"
DISK_SIZE="${LIVE_DISK:+${LIVE_DISK}GB}"
DISK_SIZE="${DISK_SIZE:-$RD_DISK_SIZE}"

log_step "File storage (minio)"
echo "minio stores uploaded audio and participant recordings. Without it the"
echo "rest of the app works, but uploads and recordings fail. It is off unless"
echo "you turn it on, and adds one container."
# Offer the current setting as the default, so a re-run keeps it.
if minio_enabled; then MINIO_DEFAULT=y; else MINIO_DEFAULT=n; fi
# Rebuild the list from what is already set, so any other compose files
# someone added by hand survive.
COMPOSE_FILES=""
for f in $RD_COMPOSE_FILES; do
    [ "$f" = "docker-compose-s3.yml" ] || COMPOSE_FILES="$COMPOSE_FILES $f"
done
if confirm "Run minio?" "$MINIO_DEFAULT"; then
    COMPOSE_FILES="$COMPOSE_FILES docker-compose-s3.yml"
fi
COMPOSE_FILES="${COMPOSE_FILES# }"

log_step "Writing local.env"
cat > "$LOCAL_ENV" <<EOF
# Written by ./scripts/remote-dev.sh init on $(date -u '+%Y-%m-%d %H:%M UTC'). Gitignored.
#
# Per-person settings for the remote dev VM. Edit freely, or re-run
# ./scripts/remote-dev.sh init to regenerate. Team-wide defaults live in
# config.sh; anything you set here overrides them, and an explicit env var
# overrides both.

RD_PROJECT="$PROJECT"
RD_ZONE="$ZONE"
RD_MACHINE_TYPE="$MACHINE"
RD_DISK_SIZE="$DISK_SIZE"
RD_INSTANCE_NAME="$INSTANCE"
RD_ORG_DOMAIN="$ORG_DOMAIN"
RD_ORG_ID="$ORG_ID"

# Add docker-compose-s3.yml to run minio, then run:
#   ./scripts/remote-dev.sh up --skip-setup
RD_COMPOSE_FILES="$COMPOSE_FILES"
EOF

log_info "Wrote $LOCAL_ENV"
echo
cat "$LOCAL_ENV" | grep -v '^#' | grep -v '^$' | sed 's/^/  /'

log_step "Next"
cat <<EOF
  ./scripts/remote-dev.sh create  create the VM, install docker, clone the repo,
                                 and add the SSH host entries Zed connects through
  ./scripts/remote-dev.sh up      bring the stack up and install dependencies

Or run both at once:
  ./scripts/remote-dev.sh create && ./scripts/remote-dev.sh up
EOF
