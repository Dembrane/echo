# Guest unification — backend

## What to build

Remove the separate guest cap concept from the tier matrix and seat enforcement. Members and guests now count toward the same seat pool.

Specifically:
- The `TierCapacity` dataclass loses its `guest_cap` field; every tier entry is updated.
- The effective seat state function counts distinct users regardless of `is_external`; the response can still expose `member_count` and `guest_count` separately for UI breakdown, but `seats_used` is the unified sum and is what enforces the cap.
- The dedicated guest-only 402 gate is replaced with a single `seats_used >= included_seats` check that fires for both member and guest invites.
- Tests are updated to assert the unified model: a guest counts toward seats; invite blocking fires on the unified cap regardless of role.

The `is_external` column itself stays — it continues to drive role/permission policy (guest = read-mostly). Only the *capacity* concept is unified.

Free's `included_seats=1` (the owner) means a free workspace cannot host any other user — member, guest, anyone. This is intentional: collaboration of any kind requires upgrading to pilot.

## Acceptance criteria

- [ ] `TierCapacity` dataclass no longer has a `guest_cap` field.
- [ ] Every tier entry in the canonical matrix no longer carries `guest_cap`.
- [ ] Effective seat state function counts distinct users regardless of `is_external`.
- [ ] The response still exposes `member_count` and `guest_count` separately for UI breakdown.
- [ ] `seats_used` is the unified sum and is the value that enforces the cap.
- [ ] Inviting a member or guest against an at-cap workspace returns 402 with the same error code for both roles.
- [ ] A free workspace (1 seat, owner present) rejects any new invite — member or guest.
- [ ] `is_external` continues to map to the guest policy role with read-mostly permissions.
- [ ] Backend unit tests for the unified seat model pass.
- [ ] `scripts/matrix_smoke.py` (the tier matrix smoke test) passes without the removed `guest_cap` field.

## Blocked by

None — can start immediately.
