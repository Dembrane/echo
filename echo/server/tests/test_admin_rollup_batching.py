"""billing_rollup must batch: no per-workspace Directus fan-out."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import admin as admin_mod

WS = [
    {"id": "ws-1", "org_id": "org-1", "settings": {}, "visibility": "open_to_organisation"},
    {
        "id": "ws-2",
        "org_id": "org-1",
        "settings": {"usage_reset_at": "2026-07-10T00:00:00+00:00"},
        "visibility": "private",
    },
]
CYCLE = ("2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00")


def _fake_get_items(calls):
    async def _impl(collection, payload):
        query = payload["query"]
        calls.append((collection, query))
        if collection == "project":
            return [
                {"id": "p1", "workspace_id": "ws-1"},
                {"id": "p2", "workspace_id": "ws-2"},
            ]
        if collection == "conversation":
            assert "aggregate" in query and query.get("groupBy") == ["project_id"]
            # Directus truncates grouped rows at its default limit without this.
            assert query.get("limit") == -1, f"grouped aggregate missing limit -1: {query}"
            gte = query["filter"]["created_at"]["_gte"]
            if gte == "2026-07-10T00:00:00+00:00":
                return [{"project_id": "p2", "sum": {"duration": 3600}}]
            return [{"project_id": "p1", "sum": {"duration": 7200}}]
        if collection == "workspace_membership":
            assert query["filter"]["workspace_id"] == {"_in": ["ws-1", "ws-2"]}
            return [
                {"workspace_id": "ws-1", "user_id": "u1", "role": "owner",
                 "source": "direct", "custom_policies": None, "created_at": "t1"},
                {"workspace_id": "ws-1", "user_id": "u2", "role": "external",
                 "source": "direct", "custom_policies": None, "created_at": "t2"},
                {"workspace_id": "ws-2", "user_id": "u1", "role": "admin",
                 "source": "staff_support", "custom_policies": None, "created_at": "t3"},
            ]
        if collection == "org_membership":
            return [{"org_id": "org-1", "user_id": "u9", "role": "admin"}]
        if collection == "app_user":
            return [{"id": "u1", "display_name": "U One", "email": "u1@x.com"}]
        raise AssertionError(f"unexpected collection {collection}")

    return _impl


@pytest.mark.asyncio
async def test_batch_maps_no_per_workspace_fanout():
    calls: list = []
    with patch.object(
        admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_fake_get_items(calls))
    ):
        hours, members, admin_rows, degraded = await admin_mod._batch_rollup_maps(
            WS, *CYCLE
        )

    assert degraded is False
    assert hours == {"ws-1": 2.0, "ws-2": 1.0}
    # ws-1: direct owner + external, derived org admin (open visibility)
    ws1_roles = {(m["user_id"], m["role"], m["source"]) for m in members["ws-1"]}
    assert ws1_roles == {
        ("u1", "owner", "direct"),
        ("u2", "external", "direct"),
        ("u9", "admin", "inherited"),
    }
    # ws-2: staff_support row excluded from members; private blocks org admin
    assert members["ws-2"] == []
    # admins keep staff_support rows (parity with old _workspace_admins)
    assert [r["user_id"] for r in admin_rows["ws-1"]] == ["u1"]
    assert [r["user_id"] for r in admin_rows["ws-2"]] == ["u1"]
    # exactly one query per collection, plus one per distinct effective_start
    per_collection = {}
    for collection, _ in calls:
        per_collection[collection] = per_collection.get(collection, 0) + 1
    assert per_collection["project"] == 1
    assert per_collection["workspace_membership"] == 1
    assert per_collection["org_membership"] == 1
    assert per_collection["conversation"] == 2  # two reset_at buckets


@pytest.mark.asyncio
async def test_batch_maps_degrades_on_error_envelope():
    async def _impl(collection, payload):
        if collection == "project":
            return {"error": "boom"}
        return []

    with patch.object(admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        hours, members, admin_rows, degraded = await admin_mod._batch_rollup_maps(WS, *CYCLE)
    assert degraded is True
    assert hours == {}


@pytest.mark.asyncio
async def test_rollup_cache_hit_skips_compute():
    cached = {
        "cycle_start": CYCLE[0],
        "cycle_end_exclusive": CYCLE[1],
        "workspace_count": 0,
        "active_workspace_count": 0,
        "total_base_eur": 0.0,
        "total_overage_eur": 0.0,
        "total_forecast_eur": 0.0,
        "mrr_eur": 0.0,
        "logins_last_30d": 3,
        "accounts": [],
        "rows": [],
    }
    auth = type("A", (), {"is_admin": True})()
    ws_mock = AsyncMock()
    with (
        patch.object(admin_mod, "cache_get_json", new=AsyncMock(return_value=cached)),
        patch.object(admin_mod, "_all_active_workspaces", new=ws_mock),
    ):
        res = await admin_mod.billing_rollup(auth, month_offset=0)
    assert res.logins_last_30d == 3
    ws_mock.assert_not_called()


@pytest.mark.asyncio
async def test_rollup_empty_workspaces_not_cached():
    auth = type("A", (), {"is_admin": True})()
    cache_set_mock = AsyncMock()
    with (
        patch.object(admin_mod, "_all_active_workspaces", new=AsyncMock(return_value=[])),
        patch.object(admin_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(admin_mod, "cache_set_json", new=cache_set_mock),
        patch.object(admin_mod, "_org_name_map", new=AsyncMock(return_value={})),
        patch.object(admin_mod, "_org_partner_map", new=AsyncMock(return_value={})),
        patch.object(admin_mod, "_recent_login_count", new=AsyncMock(return_value=0)),
        patch.object(admin_mod.async_directus, "get_items", new=AsyncMock(return_value=[])),
    ):
        res = await admin_mod.billing_rollup(auth, month_offset=0)
    assert res.workspace_count == 0
    cache_set_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_rollup_org_map_or_login_error_not_cached():
    """None from the org maps or login count means a Directus error: serve, never cache."""
    auth = type("A", (), {"is_admin": True})()
    ws = [{"id": "ws-1", "org_id": "org-1", "settings": {}, "visibility": "private",
           "billing_account_id": None, "account_scope": None,
           "account_payment_mode": None, "account_label": None, "tier": "free"}]
    for broken in ("_org_name_map", "_org_partner_map", "_recent_login_count"):
        cache_set_mock = AsyncMock()
        mocks = {
            "_org_name_map": AsyncMock(return_value={}),
            "_org_partner_map": AsyncMock(return_value={}),
            "_recent_login_count": AsyncMock(return_value=0),
        }
        mocks[broken] = AsyncMock(return_value=None)
        with (
            patch.object(admin_mod, "_all_active_workspaces", new=AsyncMock(return_value=ws)),
            patch.object(admin_mod, "_batch_rollup_maps",
                         new=AsyncMock(return_value=({}, {}, {}, False))),
            patch.object(admin_mod, "cache_get_json", new=AsyncMock(return_value=None)),
            patch.object(admin_mod, "cache_set_json", new=cache_set_mock),
            patch.object(admin_mod, "_org_name_map", new=mocks["_org_name_map"]),
            patch.object(admin_mod, "_org_partner_map", new=mocks["_org_partner_map"]),
            patch.object(admin_mod, "_recent_login_count", new=mocks["_recent_login_count"]),
        ):
            res = await admin_mod.billing_rollup(auth, month_offset=0)
        assert res.workspace_count == 1, broken
        cache_set_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_maps_reset_at_in_past_cycle_is_ignored():
    """A reset_at outside the displayed cycle must not floor the hours window
    (coverage moved here from the deleted _workspace_hours_this_cycle test)."""
    ws = [{"id": "ws-1", "org_id": "org-1", "visibility": "private",
           "settings": {"usage_reset_at": "2026-04-15T00:00:00+00:00"}}]
    seen_starts: list = []

    async def _impl(collection, payload):
        query = payload["query"]
        if collection == "project":
            return [{"id": "p1", "workspace_id": "ws-1"}]
        if collection == "conversation":
            seen_starts.append(query["filter"]["created_at"]["_gte"])
            return [{"project_id": "p1", "sum": {"duration": 3600}}]
        return []

    with patch.object(admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        hours, _members, _admins, degraded = await admin_mod._batch_rollup_maps(
            ws, "2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"
        )
    # reset_at is in April, outside the July cycle, so cycle_start is the floor.
    assert seen_starts == ["2026-07-01T00:00:00+00:00"]
    assert hours == {"ws-1": 1.0}
    assert degraded is False


@pytest.mark.asyncio
async def test_batch_maps_null_duration_sum_is_zero():
    """A null sum(duration) (no conversations in window) yields 0 hours, not a crash."""
    ws = [{"id": "ws-1", "org_id": "org-1", "visibility": "private", "settings": {}}]

    async def _impl(collection, payload):
        if collection == "project":
            return [{"id": "p1", "workspace_id": "ws-1"}]
        if collection == "conversation":
            return [{"project_id": "p1", "sum": {"duration": None}}]
        return []

    with patch.object(admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        hours, _members, _admins, degraded = await admin_mod._batch_rollup_maps(
            ws, "2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"
        )
    assert hours.get("ws-1", 0.0) == 0.0
    assert degraded is False
