# Admin `/upgrades` page (list + detail view)

## What to build

A new admin-only route `/admin/upgrades` lists all workspace requests. The list has status tabs (Pending / Approved / Denied) and a row per request showing kind, requester, org, proposed tier, a preview of the requester message, and the submitted timestamp. Clicking a row opens a detail view that shows the full `requester_message`, all `proposed_*` fields, and any prior `decided_*` / `denial_reason` (for non-pending rows). The detail view does NOT yet include the approve/deny actions — those land in Slices 10 and 11.

The page is gated on the staff role and is linked from the admin section of the main navigation.

Backend exposes `GET /v2/admin/workspace-requests` filterable by status, sorted by submitted timestamp descending.

## Acceptance criteria

- [ ] Route `/admin/upgrades` exists and is accessible only to users with the staff role; non-staff hit a 403 or redirect.
- [ ] `GET /v2/admin/workspace-requests` returns the list filterable by status with staff-only authorization.
- [ ] List view shows three tabs (Pending / Approved / Denied) with counts on each tab.
- [ ] Each row in the list shows kind, requester, org, proposed tier, message preview, and submitted timestamp.
- [ ] Clicking a row opens a detail view showing full `requester_message`, all `proposed_*` fields, plus any existing `decided_at` / `decided_by` / `denial_reason` for non-pending rows.
- [ ] Navigation includes an `/admin/upgrades` link visible only to staff.

## Blocked by

- Slice 8 (the `workspace_request` collection and endpoint must exist).
