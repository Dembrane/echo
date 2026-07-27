"""Pure member-resolution helpers must match the async resolvers' rules."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane import inheritance as inh
from dembrane.seat_capacity import (
    seat_state_from_members,
    seat_user_ids_from_members,
)


def _ws(visibility="open_to_organisation", org_id="org-1", settings=None):
    return {
        "id": "ws-1",
        "org_id": org_id,
        "visibility": visibility,
        "settings": settings or {},
    }


def test_direct_rows_win_and_staff_support_excluded():
    direct = [
        {"user_id": "u1", "role": "member", "custom_policies": None, "created_at": "t1"},
        {"user_id": "u2", "role": "admin", "source": "staff_support", "created_at": "t2"},
    ]
    org = [{"user_id": "u1", "role": "admin"}, {"user_id": "u3", "role": "admin"}]
    out = inh.effective_members_from_rows(_ws(), direct, org)
    by_uid = {m["user_id"]: m for m in out}
    assert by_uid["u1"]["role"] == "member" and by_uid["u1"]["source"] == "direct"
    assert "u2" not in by_uid  # staff_support never a member
    assert by_uid["u3"]["role"] == "admin" and by_uid["u3"]["source"] == "inherited"


def test_derivation_ladder_owner_carveout_and_privacy():
    org = [
        {"user_id": "owner", "role": "owner"},
        {"user_id": "admin", "role": "admin"},
        {"user_id": "member", "role": "member"},
    ]
    # private: only the org owner derives access
    out = inh.effective_members_from_rows(_ws(visibility="private"), [], org)
    assert {m["user_id"] for m in out} == {"owner"}
    # open: owner + admin derive 'admin'; member only via legacy opt-in flag
    out = inh.effective_members_from_rows(_ws(), [], org)
    assert {m["user_id"] for m in out} == {"owner", "admin"}
    out = inh.effective_members_from_rows(
        _ws(settings={"inherit_organisation_members": True}), [], org
    )
    assert {m["user_id"] for m in out} == {"owner", "admin", "member"}


def test_sticky_removed_blocks_derivation():
    org = [{"user_id": "admin", "role": "admin"}]
    ws = _ws(settings={"sticky_removed": [{"user_id": "admin"}]})
    assert inh.effective_members_from_rows(ws, [], org) == []


def test_no_org_returns_direct_only():
    direct = [{"user_id": "u1", "role": "owner", "created_at": None}]
    out = inh.effective_members_from_rows(_ws(org_id=None), direct, [{"user_id": "x", "role": "owner"}])
    assert [m["user_id"] for m in out] == ["u1"]


def test_seat_state_from_members():
    members = [
        {"user_id": "u1", "role": "owner", "source": "direct"},
        {"user_id": "u2", "role": "external", "source": "direct"},
        {"user_id": "u3", "role": "observer", "source": "direct"},
        {"user_id": "u4", "role": "admin", "source": "inherited"},  # derived: free
    ]
    assert seat_state_from_members(members) == (2, 1, 1, 1)
    assert seat_user_ids_from_members(members) == {"u1", "u2"}


@pytest.mark.asyncio
async def test_get_effective_members_delegates_to_pure():
    """Async wrapper output must equal the pure function fed the same rows."""
    ws = _ws()
    direct = [{"user_id": "u1", "role": "member", "custom_policies": [], "created_at": "t"}]
    org = [{"user_id": "u3", "role": "admin"}]

    async def _impl(collection, payload):
        if collection == "workspace_membership":
            return direct
        assert collection == "org_membership"
        return org

    with (
        patch.object(inh.async_directus, "get_item", new=AsyncMock(return_value=ws)),
        patch.object(inh.async_directus, "get_items", new=AsyncMock(side_effect=_impl)),
    ):
        out = await inh.get_effective_members("ws-1")
    assert out == inh.effective_members_from_rows(ws, direct, org)
