"""Tests for dembrane.seat_capacity — unified workspace seat cap gate.

Covers (ADR 0005):
    - Free is the only hard-block tier (single seat). Paid tiers are per-seat
      metered and never block.
    - Externals (role='external') count toward the same seat pool as members.
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
    NOT consume a seat — a seat is taken only when someone joins directly."""
    patch_members(
        [
            _direct_member("u-owner", role="owner"),
            _derived_admin("u-org-only-admin"),
        ]
    )
    seats_used, member_count, external_count = await seat_capacity.compute_effective_seat_state(
        "w-1"
    )
    assert member_count == 1
    assert external_count == 0
    assert seats_used == 1


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


# ── assert_can_add_seat (Free-only hard cap) ────────────────────────────


@pytest.mark.asyncio
async def test_free_rejects_any_invite(patch_members):
    """Free tier (1 seat = owner). Any invite is blocked."""
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"))
    assert exc.value.status_code == 402
    assert "SEAT_CAP_REACHED" in (exc.value.headers or {}).get("X-Cap-Code", "")


@pytest.mark.asyncio
async def test_free_passes_when_empty(patch_members):
    """Free with no direct members (only derived oversight) is 0/1 — passes."""
    patch_members([_derived_admin("u-org-admin")])
    await seat_capacity.assert_can_add_seat(_ws("free"))  # no raise


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["innovator", "changemaker", "guardian"])
async def test_paid_tiers_never_block(patch_members, tier: str):
    """Paid tiers are per-seat metered — they never block, even far over."""
    patch_members([_direct_member(f"u-{i}", role="member") for i in range(50)])
    await seat_capacity.assert_can_add_seat(_ws(tier))  # no raise


@pytest.mark.asyncio
async def test_paid_tier_external_never_blocks(patch_members):
    patch_members([_direct_external(f"u-{i}") for i in range(20)])
    await seat_capacity.assert_can_add_seat(_ws("changemaker"))  # no raise


@pytest.mark.asyncio
async def test_unknown_tier_unlimited(patch_members):
    patch_members([_direct_member(f"u-{i}") for i in range(20)])
    await seat_capacity.assert_can_add_seat(_ws("legacy-mystery-tier"))


# ── include_pending (Free cap) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_pending_invites_count_on_free(patch_members, patch_pending):
    """include_pending=True: 0 used + 1 pending against Free's 1-seat cap → 402."""
    patch_members([])  # only derived/no direct seats
    patch_pending(member_pending=1, external_pending=0)
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"), include_pending=True)
    assert exc.value.status_code == 402


@pytest.mark.asyncio
async def test_pending_external_invites_count_on_free(patch_members, patch_pending):
    """Pending externals count like pending members (unified pool)."""
    patch_members([])
    patch_pending(member_pending=0, external_pending=1)
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"), include_pending=True)
    assert exc.value.status_code == 402


# ── audience message formatting ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_invitee_message_is_friendly(patch_members):
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"), audience="invitee")
    assert "contact the workspace admin" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_admin_message_names_tier_and_cap(patch_members):
    patch_members([_direct_member("u-owner", role="owner")])
    with pytest.raises(HTTPException) as exc:
        await seat_capacity.assert_can_add_seat(_ws("free"), audience="admin")
    detail = str(exc.value.detail).lower()
    assert "1-seat" in detail
    assert "free" in detail


# ── tier_hard_blocks_seats ──────────────────────────────────────────────


def test_only_free_hard_blocks_seats():
    assert seat_capacity.tier_hard_blocks_seats("free") is True
    for tier in ("innovator", "changemaker", "guardian", "pilot", "pioneer", "unknown"):
        assert seat_capacity.tier_hard_blocks_seats(tier) is False
