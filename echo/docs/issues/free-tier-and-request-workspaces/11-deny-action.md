# Deny action (orchestrator + dialog)

## What to build

Staff can deny a workspace request from the admin upgrades page. The deny dialog requires a free-text `denial_reason` (non-empty). Submitting fires `PATCH /v2/admin/workspace-requests/{id}` with `action=deny`. The backend sets `status=denied`, stores the reason, and stamps `decided_at` + `decided_by`. No workspace or tier change happens on deny.

Notifications/emails for denial are NOT in this slice — they land in Slice 12.

## Acceptance criteria

- [ ] `PATCH /v2/admin/workspace-requests/{id}` with `action=deny` is staff-only.
- [ ] `denial_reason` is required; empty or missing returns 400.
- [ ] On success, `status` becomes `denied`, `denial_reason`, `decided_at`, and `decided_by` are written.
- [ ] A second deny on an already-decided row is a no-op or returns 409.
- [ ] Denied requests appear in the Denied tab in the admin page with the reason visible in the detail view.
- [ ] No workspace is created and no existing workspace's tier changes.

## Blocked by

- Slice 9 (the admin page exists for staff to see and act on requests).
