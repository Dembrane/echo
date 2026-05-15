# Tier-upgrade kind through the same flow + old endpoint removed

## What to build

In-workspace tier-upgrade requests flow through the same `workspace_request` collection used by new-workspace requests. The existing email-only upgrade-request endpoint (which just sent an email to staff with no audit trail) is removed.

The in-workspace "Request upgrade" affordance posts to `POST /v2/workspace-requests` with `kind=tier_upgrade`, supplying `workspace_id` and the user's `proposed_tier`. Role validation requires the user to be workspace admin or billing. The approval orchestrator (Slice 10) already handles the `tier_upgrade` kind correctly; this slice connects the in-workspace UI to that flow.

The tier picker for upgrade requests shows tiers strictly higher than the current workspace tier. `free` remains unselectable. Default is the next tier up from the current one (e.g. on pilot, default = pioneer).

## Acceptance criteria

- [ ] The old email-only upgrade-request endpoint is removed.
- [ ] In-workspace "Request upgrade" submits to `/v2/workspace-requests` with `kind=tier_upgrade`, `workspace_id`, and the chosen `proposed_tier`.
- [ ] Workspace admin or billing role is required to submit.
- [ ] Approve on a `tier_upgrade` request changes the workspace's tier via the existing tier-change path.
- [ ] The upgrade tier picker only offers tiers strictly higher than the current one.
- [ ] `free` is never offered as an upgrade target.
- [ ] An in-flight upgrade request prevents the same workspace from submitting another `tier_upgrade` request until the first is decided (returns 409 with a clear message).

## Blocked by

- Slice 10 (approve action exists and handles `kind=tier_upgrade`).
