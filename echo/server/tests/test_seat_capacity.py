"""Tests for dembrane.seat_capacity — unified workspace seat cap gate.

Covers:
    - Per-tier hard-block matrix: free + pilot hard-block; pioneer+ allow
      seat overage; guardian + unknown tiers are unlimited.
    - Externals (role='external') count toward the same seat pool as members.
    - A free workspace (1 seat = the owner) rejects any invite.
    - Effective seat state returns (seats_used, member_count, external_count).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from dembrane import seat_capacity


def _ws(tier: str, ws_id: str = "w-1") -> dict:
    return {"id": ws_id, "tier": tier}


def _direct_member(uid: str, role: str = "member") -> dict:
    return {
        "user_id": uid,
        "role": role,
        "source": "direct",
        "custom_policies": [],
        "created_at": None,
    }


def _direct_external(uid: str) -> dict:
    return _direct_member(uid, role="external")


def _derived_admin(uid: str) -> dict:
    return {
        "user_id": uid,
        "role": "admin",
        "source": "inherited",
        "custom_policies": [],
        "created_at": None,
    }


@pytest.fixture
def patch_members(monkeypatch):
    """Stub get_effective_members so we don't hit Directus."""

    def _set(rows):
        async def _stub(_ws_id):
            return rows

        monkeypatch.setattr(seat_capacity, "get_effective_members", _stub)

    return _set


@pytest.fixture
def patch_pending(monkeypatch):
    """Stub count_pending_invites so include_pending tests don't hit Directus."""

    def _set(member_pending: int, external_pending: int):
        async def _stub(_ws_id):
            return member_pending, external_pending

        monkeypatch.setattr(seat_capacity, "count_pending_invites", _stub)

    return _set


# ── compute_effective_seat_state ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_seat_state_counts_direct_members_and_externals_unified(patch_members):
    """Direct members + externals share one seat pool. A derived org admin is
    present for access but does not add to the count."""
    patch_members(
        [
            _direct_member("u-owner", role="owner"),
            _derived_admin("u-org-admin"),  # oversight only, no seat
            _direct_external("u-ext"),
        ]
    )
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 1  # only the direct owner
    assert external_count == 1
    assert seats_used == 2  # unified: direct members + externals


@pytest.mark.asyncio
async def test_seat_state_dedups_by_user(patch_members):
    """A user with a direct row counts once even if also present as derived."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-2", role="member"),
            _derived_admin("u-2"),  # same user, derived — already direct, no double count
        ]
    )
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 2
    assert external_count == 0
    assert seats_used == 2


@pytest.mark.asyncio
async def test_seat_state_externals_count_toward_seats_used(patch_members):
    """Externals share the seat pool — seats_used is the sum."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_external("u-2"),
            _direct_external("u-3"),
        ]
    )
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 1
    assert external_count == 2
    assert seats_used == 3


@pytest.mark.asyncio
async def test_derived_org_admins_do_not_consume_seats(patch_members):
    """Org-only admins/owners derive workspace access for oversight but must
    NOT consume a seat — a seat is taken only when someone joins a workspace
    directly. Reproduces the 'free tier shows 2/1' bug: the org owner is a
    direct member and an org-only admin is derived; seats must stay at 1.
    """
    patch_members(
        [
            _direct_member("u-owner", role="owner"),
            _derived_admin("u-org-only-admin"),
        ]
    )
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 1  # only the direct owner occupies a seat
    assert external_count == 0
    assert seats_used == 1  # derived org admin does NOT count


@pytest.mark.asyncio
async def test_derived_only_workspace_has_zero_seats(patch_members):
    """A workspace whose only effective members are derived org admins/owners
    (no direct rows) consumes zero seats."""
    patch_members([_derived_admin("u-a"), _derived_admin("u-b")])
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 0
    assert external_count == 0
    assert seats_used == 0


# ── assert_can_add_seat (unified gate) ──────────────────────────────────


@pytest.mark.asyncio
async def test_free_rejects_any_invite(patch_members):
    """Free tier (1 seat = owner). Any invite is blocked."""
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"))
    assert exc.value.status_code == 402
    assert "SEAT_CAP_REACHED" in (exc.value.headers or {}).get("X-Cap-Code", "")


@pytest.mark.asyncio
async def test_pilot_blocks_at_cap_member(patch_members):
    """Pilot has 2 seats — blocks the 3rd member."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"))
    assert exc.value.status_code == 402
    assert "pilot" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_pilot_blocks_at_cap_external(patch_members):
    """Pilot has 2 seats — an external also counts, blocking the 3rd."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_external("u-2"),
        ]
    )
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"))
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_pilot_pass_under_cap(patch_members):
    patch_members([_direct_member("u-1", role="owner")])
    await seat_capacity.assert_can_add_seat(_ws("pilot"))


@pytest.mark.asyncio
async def test_pilot_mixed_members_and_externals_share_cap(patch_members):
    """1 member + 1 external = 2/2 seats on pilot → blocked."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_external("u-2"),
        ]
    )
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"))
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_pioneer_never_blocks_overage(patch_members):
    """Pioneer at seat cap allows new seats — overage applies."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-2"),
            _direct_member("u-3"),
        ]
    )
    await seat_capacity.assert_can_add_seat(_ws("pioneer"))
    # Even well over cap, no raise on Pioneer
    patch_members([_direct_member(f"u-{i}", role="member") for i in range(8)])
    await seat_capacity.assert_can_add_seat(_ws("pioneer"))


@pytest.mark.asyncio
async def test_pioneer_external_also_allowed_overage(patch_members):
    """Pioneer: externals also benefit from overage — no separate cap."""
    patch_members([_direct_external(f"u-{i}") for i in range(10)])
    await seat_capacity.assert_can_add_seat(_ws("pioneer"))


@pytest.mark.asyncio
async def test_guardian_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(50)])
    await seat_capacity.assert_can_add_seat(_ws("guardian"))


@pytest.mark.asyncio
async def test_unknown_tier_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(20)])
    await seat_capacity.assert_can_add_seat(_ws("legacy-mystery-tier"))


@pytest.mark.asyncio
async def test_derived_admins_do_not_count_toward_cap(patch_members):
    """Org admins with only derived (oversight) access do NOT consume seats,
    so they never push a workspace to its cap. A pilot workspace whose only
    effective members are two derived org admins is 0/2 — an invite passes."""
    patch_members([_derived_admin("u-org-admin-1"), _derived_admin("u-org-admin-2")])
    await seat_capacity.assert_can_add_seat(_ws("pilot"))  # no raise


@pytest.mark.asyncio
async def test_pending_invites_count_when_requested(patch_members, patch_pending):
    """include_pending=True: 2 used + 2 pending against 3-seat cap → 402."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    patch_pending(member_pending=2, external_pending=0)
    # Cap on free is 1; use pilot (2) to test include_pending: 2 used + 2 pending ≥ 2 → block.
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"), include_pending=True)
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_pending_external_invites_count_toward_cap(patch_members, patch_pending):
    """include_pending=True: pending externals count just like pending members
    (unified seat pool). 2 used + 2 pending externals against pilot's 2-seat
    cap → 402."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    patch_pending(member_pending=0, external_pending=2)
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"), include_pending=True)
    assert exc.value.status_code == 402


# ── audience message formatting ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_invitee_message_is_friendly(patch_members):
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"), audience="invitee")
    assert "contact the workspace admin" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_admin_message_names_tier_and_cap(patch_members):
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"), audience="admin")
    detail = str(exc.value.detail).lower()
    assert "2-seat" in detail
    assert "pilot" in detail


# ── tier_hard_blocks_seats ──────────────────────────────────────────────


def test_tier_hard_blocks_seats_free_and_pilot():
    assert seat_capacity.tier_hard_blocks_seats("free") is True
    assert seat_capacity.tier_hard_blocks_seats("pilot") is True
    for tier in ("pioneer", "innovator", "changemaker", "guardian", "unknown"):
        assert seat_capacity.tier_hard_blocks_seats(tier) is False
