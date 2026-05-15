"""Tests for dembrane.seat_capacity — unified workspace seat cap gate.

Covers:
    - Per-tier hard-block matrix: free + pilot hard-block; pioneer+ allow
      seat overage; guardian + unknown tiers are unlimited.
    - Guests (is_external) count toward the same seat pool as members.
    - A free workspace (1 seat = the owner) rejects any invite.
    - Effective seat state returns (seats_used, member_count, guest_count).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from dembrane import seat_capacity


def _ws(tier: str, ws_id: str = "w-1") -> dict:
    return {"id": ws_id, "tier": tier}


def _direct_member(uid: str, role: str = "member", is_external: bool = False) -> dict:
    return {
        "user_id": uid,
        "role": role,
        "source": "direct",
        "is_external": is_external,
        "custom_policies": [],
        "created_at": None,
    }


def _derived_admin(uid: str) -> dict:
    return {
        "user_id": uid,
        "role": "admin",
        "source": "inherited",
        "is_external": False,
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


# ── compute_effective_seat_state ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_seat_state_counts_members_and_guests_unified(patch_members):
    patch_members(
        [
            _direct_member("u-owner", role="owner"),
            _derived_admin("u-org-admin"),
            _direct_member("u-guest", role="member", is_external=True),
        ]
    )
    seats_used, member_count, guest_count = await seat_capacity.compute_effective_seat_state("w-1")
    assert member_count == 2  # owner (direct) + org-admin (derived)
    assert guest_count == 1
    assert seats_used == 3  # unified: members + guests


@pytest.mark.asyncio
async def test_seat_state_dedups_by_user(patch_members):
    """A user with both a direct row and a derived path counts once."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _derived_admin("u-2"),
            _derived_admin("u-2"),
        ]
    )
    seats_used, member_count, guest_count = await seat_capacity.compute_effective_seat_state("w-1")
    assert member_count == 2
    assert guest_count == 0
    assert seats_used == 2


@pytest.mark.asyncio
async def test_seat_state_guests_count_toward_seats_used(patch_members):
    """Guests share the seat pool — seats_used is the sum."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-2", role="member", is_external=True),
            _direct_member("u-3", role="member", is_external=True),
        ]
    )
    seats_used, member_count, guest_count = await seat_capacity.compute_effective_seat_state("w-1")
    assert member_count == 1
    assert guest_count == 2
    assert seats_used == 3


# ── assert_can_add_seat (unified gate) ──────────────────────────────────


@pytest.mark.asyncio
async def test_free_rejects_any_invite_member(patch_members):
    """Free tier (1 seat = owner). Any member invite is blocked."""
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"))
    assert exc.value.status_code == 402
    assert "SEAT_CAP_REACHED" in (exc.value.headers or {}).get("X-Cap-Code", "")


@pytest.mark.asyncio
async def test_free_rejects_any_invite_guest(patch_members):
    """Free tier (1 seat = owner). Any guest invite is blocked."""
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_guest(_ws("free"))
    assert exc.value.status_code == 402
    assert "SEAT_CAP_REACHED" in (exc.value.headers or {}).get("X-Cap-Code", "")


@pytest.mark.asyncio
async def test_pilot_blocks_at_cap_member(patch_members):
    """Pilot has 2 seats — blocks the 3rd member."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_member(_ws("pilot"))
    assert exc.value.status_code == 402
    assert "pilot" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_pilot_blocks_at_cap_guest(patch_members):
    """Pilot has 2 seats — a guest also counts, blocking the 3rd."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-2", role="member", is_external=True),
        ]
    )
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_guest(_ws("pilot"))
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_pilot_pass_under_cap(patch_members):
    patch_members([_direct_member("u-1", role="owner")])
    await seat_capacity.assert_can_add_seat(_ws("pilot"))


@pytest.mark.asyncio
async def test_pilot_mixed_members_and_guests_share_cap(patch_members):
    """1 member + 1 guest = 2/2 seats on pilot → blocked."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-guest", role="member", is_external=True),
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
async def test_pioneer_guest_also_allowed_overage(patch_members):
    """Pioneer: guests also benefit from overage — no separate guest cap."""
    patch_members(
        [_direct_member(f"u-{i}", role="member", is_external=True) for i in range(10)]
    )
    await seat_capacity.assert_can_add_guest(_ws("pioneer"))


@pytest.mark.asyncio
async def test_guardian_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(50)])
    await seat_capacity.assert_can_add_seat(_ws("guardian"))


@pytest.mark.asyncio
async def test_unknown_tier_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(20)])
    await seat_capacity.assert_can_add_seat(_ws("legacy-mystery-tier"))


@pytest.mark.asyncio
async def test_derived_admins_count_toward_cap(patch_members):
    """Org admins (derived) count toward pilot's seat cap."""
    patch_members([_derived_admin("u-org-admin-1"), _derived_admin("u-org-admin-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("pilot"))
    assert exc.value.status_code == 402


# ── same error code for members and guests ───────────────────────────────


@pytest.mark.asyncio
async def test_same_error_code_member_and_guest(patch_members):
    """Both member and guest invites produce the same SEAT_CAP_REACHED code."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])

    with pytest.raises(HTTPException) as exc_member:
        await seat_capacity.assert_can_add_member(_ws("pilot"))
    with pytest.raises(HTTPException) as exc_guest:
        await seat_capacity.assert_can_add_guest(_ws("pilot"))

    assert exc_member.value.headers["X-Cap-Code"] == "SEAT_CAP_REACHED"
    assert exc_guest.value.headers["X-Cap-Code"] == "SEAT_CAP_REACHED"


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


# ── is_external continues to map to guest policy role ────────────────────


@pytest.mark.asyncio
async def test_is_external_still_tracked_separately(patch_members):
    """is_external still produces a separate guest_count in the state tuple."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-g1", role="member", is_external=True),
            _direct_member("u-g2", role="member", is_external=True),
        ]
    )
    seats_used, member_count, guest_count = await seat_capacity.compute_effective_seat_state("w-1")
    assert guest_count == 2
    assert member_count == 1
    assert seats_used == 3
