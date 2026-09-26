#!/usr/bin/env bash
# Seeds a demo project with finished conversations, for trying the Map and analysis.
#
# Runs server/scripts/popcorn_demo.py --seed-local in the container. It writes
# the fictional housing corporation in demos/example/ into a workspace: five
# conversations with transcripts, the research as project context, and a
# paused Popcorn report. No model is called while seeding. Generating a Map on
# the project afterwards exercises extraction and embeddings.
#
# A workspace only exists after the first login and onboarding at
# localhost:5173, so run this after that. With one workspace it is used; with
# several, pick one:
#
#   ./scripts/remote-dev.sh seed
#   ./scripts/remote-dev.sh seed --workspace <id>
#
# Ids are deterministic, so re-running resets the demo instead of adding
# another copy.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

WORKSPACE_ID=""
while [ $# -gt 0 ]; do
    case "$1" in
        --workspace) WORKSPACE_ID="${2:-}"; [ -n "$WORKSPACE_ID" ] || die "--workspace needs an id"; shift 2 ;;
        *) die "Unknown option: $1" ;;
    esac
done

require_gcloud
require_running

log_step "Workspace"
# The project's owner is the Directus user behind the workspace's creator.
WORKSPACES="$(vm_psql "select w.id, w.name, o.name, u.directus_user_id, u.email
    from workspace w
    join app_user u on u.id = w.created_by
    left join org o on o.id = w.org_id
    where w.deleted_at is null
    order by w.created_at" 2>/dev/null)" \
    || die "Could not read the workspaces. Is postgres up? Check ./scripts/remote-dev.sh status"

if [ -z "$WORKSPACES" ]; then
    die "No workspace yet. Log in at http://localhost:5173 (with the tunnel open) and finish onboarding, which creates one, then re-run this."
fi

if [ -n "$WORKSPACE_ID" ]; then
    ROW="$(echo "$WORKSPACES" | awk -F'|' -v id="$WORKSPACE_ID" '$1 == id')"
    [ -n "$ROW" ] || die "No workspace '$WORKSPACE_ID'. These exist:
$(echo "$WORKSPACES" | awk -F'|' '{print "  " $1 "  " $3 " / " $2 "  (" $5 ")"}')"
elif [ "$(echo "$WORKSPACES" | wc -l | tr -dc '0-9')" -eq 1 ]; then
    ROW="$WORKSPACES"
else
    die "More than one workspace. Pick one with --workspace <id>:
$(echo "$WORKSPACES" | awk -F'|' '{print "  " $1 "  " $3 " / " $2 "  (" $5 ")"}')"
fi

IFS='|' read -r WORKSPACE_ID WORKSPACE_NAME ORG_NAME OWNER_ID OWNER_EMAIL <<<"$ROW"
log_info "Seeding into '$ORG_NAME / $WORKSPACE_NAME', owned by $OWNER_EMAIL"

log_step "Seed"
container_exec "cd /workspaces/echo/server && PYTHONPATH=. uv run python scripts/popcorn_demo.py --seed-local --workspace-id '$WORKSPACE_ID' --owner-id '$OWNER_ID'" \
    || die "Seeding failed. The output above says why."

log_info "Done. Open the [SYNTHETISCH] project at http://localhost:5173 and generate a Map to exercise embeddings."
