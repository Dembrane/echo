# Onboarding seeds `free` instead of `pilot`

## What to build

A user who creates an account through the standard direct-signup path now receives a free workspace, not a pilot. The existing onboarding decision tree already gates the seed correctly (direct-signup with own projects, or no internal invites) — this slice only changes the tier value handed to the seed call. Users who register by accepting an invite continue to not receive a personal workspace, matching existing behavior.

The auto-seed bypasses the workspace request flow intentionally: system-initiated workspaces don't need staff approval. Only user-initiated workspace creation goes through requests.

## Acceptance criteria

- [ ] A freshly-signed-up direct user has exactly one workspace at tier=free, is_default=true, owner=themselves.
- [ ] A user who registers by accepting a workspace invite receives no personal workspace; they join only the inviting workspace.
- [ ] Re-triggering onboarding for a user who already owns a workspace creates no additional workspace (idempotent).
- [ ] Existing workspaces created at signup before this change keep their current tier (no migration / no backfill).
- [ ] A code comment at the seed call site notes that this bypasses the workspace_request flow intentionally.

## Blocked by

- Slice 1 (`free` tier must exist before onboarding can reference it).
