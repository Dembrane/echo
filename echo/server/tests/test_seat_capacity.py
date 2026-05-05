"""Tests for dembrane.seat_capacity — the workspace seat + guest cap gate.

Covers:
    - Per-tier hard-block matrix (Pilot blocks seats; Pioneer+ allow seat
      overage; guest cap is hard at every finite-cap tier; Guardian and
      unknown tiers are unlimited).
    - Effective-member counting includes derived org admins/owners
      (matrix v1.1 §7 + product call 2026-05-04).
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
async def test_seat_state_counts_direct_and_derived_as_seats(patch_members):
    patch_members(
        [
            _direct_member("u-owner", role="owner"),
            _derived_admin("u-org-admin"),
            _direct_member("u-guest", role="member", is_external=True),
        ]
    )
    seats, guests = await seat_capacity.compute_effective_seat_state("w-1")
    assert seats == 2  # owner (direct) + org-admin (derived)
    assert guests == 1


@pytest.mark.asyncio
async def test_seat_state_dedups_by_user(patch_members):
    """A user with both a direct row and a derived path counts once.
    get_effective_members already does this dedup; we just verify our
    counter doesn't undo it."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            # Derived rows for the same user shouldn't show up at all
            # (inheritance.get_effective_members dedups), but if they
            # did our set-based counter would still dedup.
            _derived_admin("u-2"),
            _derived_admin("u-2"),
        ]
    )
    seats, guests = await seat_capacity.compute_effective_seat_state("w-1")
    assert seats == 2
    assert guests == 0


# ── assert_can_add_member ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_block_pilot_at_cap(patch_members):
    """Pilot has 2 included seats — blocks the 3rd."""
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_member(_ws("pilot"))
    assert exc.value.status_code == 402
    assert "pilot" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_member_pass_pilot_under_cap(patch_members):
    patch_members([_direct_member("u-1", role="owner")])
    # 1/2 — should not raise
    await seat_capacity.assert_can_add_member(_ws("pilot"))


@pytest.mark.asyncio
async def test_member_pioneer_never_blocks_overage(patch_members):
    """Pioneer at member cap allows new members — overage applies (matrix §8)."""
    patch_members(
        [
            _direct_member("u-1", role="owner"),
            _direct_member("u-2"),
            _direct_member("u-3"),
        ]
    )
    # 3/3 — Pioneer overage, no raise
    await seat_capacity.assert_can_add_member(_ws("pioneer"))
    # Even if we're 5 seats over, no raise on Pioneer
    patch_members([_direct_member(f"u-{i}", role="member") for i in range(8)])
    await seat_capacity.assert_can_add_member(_ws("pioneer"))


@pytest.mark.asyncio
async def test_member_guardian_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(50)])
    await seat_capacity.assert_can_add_member(_ws("guardian"))


@pytest.mark.asyncio
async def test_member_unknown_tier_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(20)])
    await seat_capacity.assert_can_add_member(_ws("legacy-mystery-tier"))


@pytest.mark.asyncio
async def test_member_pilot_block_counts_derived_admins(patch_members):
    """Org admins (derived) count toward pilot's seat cap. With 2 derived
    admins on Pilot, the next direct member is blocked."""
    patch_members([_derived_admin("u-org-admin-1"), _derived_admin("u-org-admin-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_member(_ws("pilot"))
    assert exc.value.status_code == 402


# ── assert_can_add_guest ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_block_pilot_at_cap(patch_members):
    """Pilot has 2 guest cap — blocks the 3rd guest."""
    patch_members(
        [
            _direct_member("u-1", role="member", is_external=True),
            _direct_member("u-2", role="member", is_external=True),
        ]
    )
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_guest(_ws("pilot"))
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_guest_block_pioneer_at_cap(patch_members):
    """Guest cap is hard at every finite-cap tier — Pioneer caps guests at 5."""
    patch_members([_direct_member(f"u-{i}", role="member", is_external=True) for i in range(5)])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_guest(_ws("pioneer"))
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_guest_pass_under_cap(patch_members):
    patch_members([_direct_member("u-1", role="member", is_external=True)])
    # 1/2 — pass on Pilot
    await seat_capacity.assert_can_add_guest(_ws("pilot"))


@pytest.mark.asyncio
async def test_guest_guardian_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}", role="member", is_external=True) for i in range(100)])
    await seat_capacity.assert_can_add_guest(_ws("guardian"))


# ── audience message formatting ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_invitee_message_is_friendly(patch_members):
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_member(_ws("pilot"), audience="invitee")
    assert "contact the workspace admin" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_admin_message_names_tier_and_cap(patch_members):
    patch_members([_direct_member("u-1", role="owner"), _direct_member("u-2")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_member(_ws("pilot"), audience="admin")
    detail = str(exc.value.detail).lower()
    assert "2-seat" in detail
    assert "pilot" in detail


# ── tier_hard_blocks_seats ──────────────────────────────────────────────


def test_tier_hard_blocks_seats_only_pilot():
    assert seat_capacity.tier_hard_blocks_seats("pilot") is True
    for tier in ("pioneer", "innovator", "changemaker", "guardian", "unknown"):
        assert seat_capacity.tier_hard_blocks_seats(tier) is False
