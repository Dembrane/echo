# Workspace request notifications + emails

## What to build

Three new event codes are added to the notification system:

- `WORKSPACE_REQUEST_SUBMITTED` — action_required, audience = staff
- `WORKSPACE_REQUEST_APPROVED` — info, audience = requester
- `WORKSPACE_REQUEST_DENIED` — info, audience = requester

A new `audience_staff()` helper resolves to all Directus users with admin access. Three email templates are added that extend the existing layout and follow the established pattern (HTML + TXT pairs).

Wiring:
- The request submission endpoint (from Slice 8) fires `WORKSPACE_REQUEST_SUBMITTED` to all staff.
- The approve action (Slice 10) fires `WORKSPACE_REQUEST_APPROVED` to the requester with a deep link to the new or upgraded workspace.
- The deny action (Slice 11) fires `WORKSPACE_REQUEST_DENIED` to the requester including the `denial_reason`.

Each event produces both an in-app notification and an email. The submission email copy is honest about timing: "Thanks — we'll be in touch within 1 business day."

This slice also pre-registers a `TIER_EXPIRED` event code as a placeholder so Slice 15 can wire its template without re-touching the notification registry. The actual TIER_EXPIRED emission lands in Slice 15.

## Acceptance criteria

- [ ] Three new event codes are registered with the right audience semantics.
- [ ] `audience_staff()` returns all Directus users with admin access.
- [ ] Submitting a request emits `WORKSPACE_REQUEST_SUBMITTED` to all staff (in-app + email).
- [ ] Approving a request emits `WORKSPACE_REQUEST_APPROVED` to the requester with a deep link to the new or upgraded workspace.
- [ ] Denying a request emits `WORKSPACE_REQUEST_DENIED` to the requester including the `denial_reason`.
- [ ] Three email templates exist (HTML + TXT each) and render correctly.
- [ ] `TIER_EXPIRED` event code is registered (no emission yet).

## Blocked by

- Slice 10 (approve action exists and is the emission point for APPROVED)
- Slice 11 (deny action exists and is the emission point for DENIED)
