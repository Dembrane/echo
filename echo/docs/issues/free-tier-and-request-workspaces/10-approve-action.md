# Approve action (orchestrator + dialog)

## What to build

Staff can approve a workspace request from the admin upgrades page. The approve dialog shows the proposed terms and lets staff optionally override:

- `granted_tier` (defaults to `proposed_tier`)
- `granted_tier_expires_at` (defaults to null; for pilot, staff typically sets it to creation + 1 month at this step)
- `granted_type_discount` and `granted_percent_discount` (default null)

Submitting fires a backend orchestrator at `PATCH /v2/admin/workspace-requests/{id}` with `action=approve`. The orchestrator:

- For `kind=new_workspace`: creates a workspace at the granted tier with the proposed name + visibility, populates `resulting_workspace_id`, attaches discount and expiry if granted.
- For `kind=tier_upgrade`: calls the existing tier-change logic to update the target workspace's tier, attaches discount and expiry if granted, sets `resulting_workspace_id` equal to the existing `workspace_id`.
- Stamps `decided_at` and `decided_by` on the request row.

As part of this slice, the existing self-serve workspace creation endpoint becomes **staff-only**: it is now an internal endpoint called by the approval orchestrator. The auto-seed step in onboarding writes directly to Directus and is unaffected.

Notifications/emails for approval are NOT in this slice — they land in Slice 12.

## Acceptance criteria

- [ ] `PATCH /v2/admin/workspace-requests/{id}` with `action=approve` runs the orchestration and is staff-only.
- [ ] For `kind=new_workspace`: a workspace is created at `granted_tier` with the requested name + visibility; `resulting_workspace_id` is populated; the requester becomes the owner.
- [ ] For `kind=tier_upgrade`: the target workspace's tier is updated via the existing tier-change path; `resulting_workspace_id` equals `workspace_id`.
- [ ] Approve dialog accepts `granted_tier`, `granted_tier_expires_at`, `granted_type_discount`, `granted_percent_discount` as optional overrides.
- [ ] `decided_at` and `decided_by` are written on approve.
- [ ] Status transitions from `pending` to `approved`; a second approve on the same row is a no-op or returns 409.
- [ ] Self-serve workspace creation endpoint (the one the wizard previously hit) returns 403 for non-staff post-change.
- [ ] Onboarding's auto-seed continues to work (it writes directly, bypassing the API).

## Blocked by

- Slice 9 (the admin page exists for staff to see and act on requests).
