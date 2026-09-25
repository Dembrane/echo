#!/usr/bin/env bash
# Pushes your laptop's working copy up to the VM's checkout.
#
# The VM has its own clone, and nothing syncs code into it: sync-env.sh only
# carries the gitignored .env files. So edits made on your laptop are invisible
# to the dev servers until they get up there, either by pushing a branch and
# pulling it on the VM, or by running this.
#
# Only git-tracked files are copied, working-tree state included, so uncommitted
# edits land too. Untracked files are ignored: they are usually build output,
# local scratch or secrets, and .env files have their own script.
#
# This writes into the VM's working tree without touching its branch, so its
# `git status` will show your changes as local modifications. That is fine for
# a quick fix, but the VM's HEAD may sit on a different commit than yours, so
# prefer a branch push for anything you want to keep.
#
#   ./scripts/remote-dev.sh sync-code                copy every tracked file
#   ./scripts/remote-dev.sh sync-code --dry-run      list what would be copied, change nothing
#   ./scripts/remote-dev.sh sync-code echo/frontend  copy only what is tracked under this path
#   ./scripts/remote-dev.sh sync-code --check        print the tracked files whose content differs, change nothing

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

# scripts/remote-dev -> scripts -> echo -> repo root. The git root is one level
# above echo/, and remote paths are relative to it, so both ends agree.
RD_REPO_ROOT="$(cd "$RD_ECHO_ROOT/.." && pwd)"

# Both stay empty in the common case, and macOS ships bash 3.2, where `set -u`
# treats an empty array expansion as unbound. Hence the ${arr[@]+...} guards at
# the use sites below.
DRY_RUN=()
PATHSPEC=()
CHECK=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=(--dry-run --itemize-changes) ;;
        --check) CHECK=true ;;
        -*) die "Unknown option: $arg" ;;
        *) PATHSPEC+=("$arg") ;;
    esac
done

# --check output is read by up.sh, so the log lines go to stderr and only the
# file list to stdout.
if [ "$CHECK" = true ]; then
    exec 3>&1 1>&2
fi

require_gcloud
require_running

command -v rsync >/dev/null 2>&1 || die "rsync not found. Install it: brew install rsync"

# rsync goes over the ssh alias rather than `gcloud compute ssh`, which has no
# way to act as a plain transport. ssh-config.sh writes the alias, and create
# and start refresh it whenever the VM's ephemeral IP changes.
grep -qE "^Host .*\b$RD_SSH_HOST\b" "$HOME/.ssh/config" 2>/dev/null \
    || die "No '$RD_SSH_HOST' entry in ~/.ssh/config. Write one with: ./scripts/remote-dev.sh ssh-config"
# A VM started from the console skips that refresh, and rsync would then time
# out dialing the old IP.
ALIAS_IP="$(ssh -G "$RD_SSH_HOST" 2>/dev/null | awk '$1 == "hostname" { print $2 }')"
VM_IP="$(instance_ip)"
[ "$ALIAS_IP" = "$VM_IP" ] \
    || die "'$RD_SSH_HOST' in ~/.ssh/config points at $ALIAS_IP, but the VM is at $VM_IP. Refresh it with: ./scripts/remote-dev.sh ssh-config"

# For up.sh: file names only, one per line. --checksum because a fresh clone
# and your checkout never share mtimes, so rsync's usual size-and-mtime test
# would list every file. Directory entries are just their mtimes.
if [ "$CHECK" = true ]; then
    CHANGED="$(git -C "$RD_REPO_ROOT" ls-files -z -- ${PATHSPEC[@]+"${PATHSPEC[@]}"} \
        | rsync --archive --dry-run --checksum --out-format='%n' \
            --files-from=- --from0 \
            --rsh=ssh \
            "$RD_REPO_ROOT/" "$RD_SSH_HOST:$RD_REPO_DIR/")"
    echo "$CHANGED" | grep -v -e '/$' -e '^$' >&3 || true
    exit 0
fi

# The VM's own uncommitted edits are about to be overwritten wherever they
# overlap with yours, and unlike a git merge nothing will say so afterwards.
REMOTE_DIRTY="$(vm_ssh "cd '$RD_REPO_DIR' && git diff --name-only" 2>/dev/null || true)"
if [ -n "$REMOTE_DIRTY" ]; then
    log_warn "The VM has uncommitted changes to these tracked files:"
    echo "$REMOTE_DIRTY" | sed 's/^/    /'
    log_warn "Any of them you also track locally will be overwritten."
fi

log_step "Syncing"
log_info "$RD_REPO_ROOT -> $RD_SSH_HOST:$RD_REPO_DIR"

# --files-from with NUL separators is what keeps this to tracked files only, and
# survives the spaces and unicode that plain `find` piping would mangle. No
# --delete: a file you have not got is far more often one the VM needs than one
# it should lose.
git -C "$RD_REPO_ROOT" ls-files -z -- ${PATHSPEC[@]+"${PATHSPEC[@]}"} \
    | rsync --archive --compress --human-readable \
        ${DRY_RUN[@]+"${DRY_RUN[@]}"} \
        --files-from=- --from0 \
        --rsh=ssh \
        "$RD_REPO_ROOT/" "$RD_SSH_HOST:$RD_REPO_DIR/"

if [ ${#DRY_RUN[@]} -gt 0 ]; then
    log_info "Dry run: nothing was copied."
else
    log_info "Synced. Vite picks frontend edits up on its own; the API server reloads on save."
fi
