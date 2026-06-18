"""Tests for ISSUE-024 staff dashboard cleanup.

Covers:
- account_scope flatten in `_all_active_workspaces` (organisation vs workspace).
- `total_forecast_eur` collapses to the tier base (overage removed by the
  per-seat rework); rollup totals carry no overage into the forecast.
- The new staff workspace controls: change-admin (promote, last-admin safe,
  external rejected), reset-usage (stamps settings.usage_reset_at, audit
  reason logged, hours floor respected), and the members picker. All staff-
  gated (403 for non-admin).

async_directus is mocked throughout; no live Directus.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.dependency_auth import DirectusSession


def _auth(is_admin: bool = True) -> DirectusSession:
    return DirectusSession(user_id="staff-1", is_admin=is_admin)


# ── account_scope flatten ──


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_account_scope_organisation_vs_workspace(mock_directus):
    from dembrane.api.v2.admin import _all_active_workspaces

    mock_directus.get_items = AsyncMock(
        return_value=[
            {
                "id": "ws-org",
                "name": "Org scoped",
                "org_id": "org-1",
                "billing_account_id": {
                    "id": "acc-org",
                    "tier": "changemaker",
                    "org_id": "org-1",
                    "workspace_id": None,
                },
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            },
            {
                "id": "ws-self",
                "name": "Workspace scoped",
                "org_id": "org-1",
                "billing_account_id": {
                    "id": "acc-self",
                    "tier": "innovator",
                    "org_id": None,
                    "workspace_id": "ws-self",
                },
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            },
            {
                "id": "ws-none",
                "name": "Unjoined",
                "org_id": "org-1",
                "billing_account_id": None,
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            },
        ]
    )

    rows = {r["id"]: r for r in await _all_active_workspaces()}
    assert rows["ws-org"]["account_scope"] == "organisation"
    assert rows["ws-self"]["account_scope"] == "workspace"
    assert rows["ws-none"]["account_scope"] is None


# ── forecast = base (no overage) ──


def _rollup_settings():
    billing = SimpleNamespace(mollie_enabled=False, mollie_test_mode=False)
    return SimpleNamespace(billing=billing)


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin._recent_login_count", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin.compute_effective_seat_state", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_hours_this_cycle", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_admins", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._all_active_workspaces", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._org_name_map", new_callable=AsyncMock)
async def test_forecast_is_base_only(
    mock_org_names,
    mock_workspaces,
    mock_admins,
    mock_hours,
    mock_seats,
    mock_logins,
):
    from dembrane.api.v2.admin import billing_rollup

    mock_org_names.return_value = {"org-1": "Acme"}
    mock_workspaces.return_value = [
        {
            "id": "ws-1",
            "name": "WS",
            "org_id": "org-1",
            "tier": "changemaker",
            "billing_account_id": "acc-1",
            "account_scope": "organisation",
            # Paying account (ISSUE-025): a comped/trial account would forecast
            # €0; here we want to confirm overage is NOT added to the base.
            "account_payment_mode": "mollie",
            "settings": {},
        }
    ]
    mock_admins.return_value = []
    # Way over the cap: if overage were still added this would inflate forecast.
    mock_hours.return_value = 9999.0
    mock_seats.return_value = (50, 50, 20)
    mock_logins.return_value = 0

    result = await billing_rollup(_auth(), month_offset=0)
    row = result.rows[0]
    # Forecast equals the tier base (Changemaker = 1500), overage NOT added.
    assert row.base_price_eur == 1500.0
    assert row.total_forecast_eur == 1500.0
    assert result.total_forecast_eur == 1500.0


# ── reset-usage floor in hours computation ──


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_reset_at_floors_hours(mock_directus):
    from dembrane.api.v2.admin import _workspace_hours_this_cycle

    captured: dict = {}

    async def _get_items(collection, query):
        if collection == "project":
            return [{"id": "p1"}]
        if collection == "conversation":
            captured["filter"] = query["query"]["filter"]
            return [{"duration": 3600}]
        return []

    mock_directus.get_items = AsyncMock(side_effect=_get_items)

    # reset_at falls inside the cycle → it becomes the lower bound.
    await _workspace_hours_this_cycle(
        "ws-1",
        "2026-06-01T00:00:00+00:00",
        "2026-07-01T00:00:00+00:00",
        reset_at="2026-06-15T00:00:00+00:00",
    )
    assert captured["filter"]["created_at"]["_gte"] == "2026-06-15T00:00:00+00:00"

    # reset_at in a different (past) cycle → ignored, cycle_start used.
    await _workspace_hours_this_cycle(
        "ws-1",
        "2026-06-01T00:00:00+00:00",
        "2026-07-01T00:00:00+00:00",
        reset_at="2026-04-15T00:00:00+00:00",
    )
    assert captured["filter"]["created_at"]["_gte"] == "2026-06-01T00:00:00+00:00"


# ── change-admin ──


@pytest.mark.asyncio
async def test_change_admin_rejects_non_staff():
    from fastapi import HTTPException

    from dembrane.api.v2.admin import ChangeWorkspaceAdminBody, change_workspace_admin

    with pytest.raises(HTTPException) as exc:
        await change_workspace_admin(
            "ws-1", ChangeWorkspaceAdminBody(membership_id="m-1"), _auth(is_admin=False)
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_change_admin_promotes_member(mock_directus):
    from dembrane.api.v2.admin import ChangeWorkspaceAdminBody, change_workspace_admin

    async def _get_item(collection, item_id):
        if collection == "workspace":
            return {"id": "ws-1", "deleted_at": None, "org_id": "org-1"}
        if collection == "workspace_membership":
            return {
                "id": "m-1",
                "workspace_id": "ws-1",
                "role": "member",
                "deleted_at": None,
            }
        return None

    mock_directus.get_item = AsyncMock(side_effect=_get_item)
    mock_directus.update_item = AsyncMock(return_value={"data": {}})

    result = await change_workspace_admin(
        "ws-1", ChangeWorkspaceAdminBody(membership_id="m-1"), _auth()
    )
    assert result["role"] == "admin"
    mock_directus.update_item.assert_awaited_once_with(
        "workspace_membership", "m-1", {"role": "admin"}
    )


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_change_admin_rejects_external(mock_directus):
    from fastapi import HTTPException

    from dembrane.api.v2.admin import ChangeWorkspaceAdminBody, change_workspace_admin

    async def _get_item(collection, item_id):
        if collection == "workspace":
            return {"id": "ws-1", "deleted_at": None}
        if collection == "workspace_membership":
            return {
                "id": "m-1",
                "workspace_id": "ws-1",
                "role": "external",
                "deleted_at": None,
            }
        return None

    mock_directus.get_item = AsyncMock(side_effect=_get_item)
    mock_directus.update_item = AsyncMock()

    with pytest.raises(HTTPException) as exc:
        await change_workspace_admin(
            "ws-1", ChangeWorkspaceAdminBody(membership_id="m-1"), _auth()
        )
    assert exc.value.status_code == 400
    mock_directus.update_item.assert_not_called()


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_change_admin_membership_in_other_workspace_404(mock_directus):
    from fastapi import HTTPException

    from dembrane.api.v2.admin import ChangeWorkspaceAdminBody, change_workspace_admin

    async def _get_item(collection, item_id):
        if collection == "workspace":
            return {"id": "ws-1", "deleted_at": None}
        if collection == "workspace_membership":
            return {"id": "m-1", "workspace_id": "ws-OTHER", "role": "member"}
        return None

    mock_directus.get_item = AsyncMock(side_effect=_get_item)

    with pytest.raises(HTTPException) as exc:
        await change_workspace_admin(
            "ws-1", ChangeWorkspaceAdminBody(membership_id="m-1"), _auth()
        )
    assert exc.value.status_code == 404


# ── reset-usage ──


@pytest.mark.asyncio
async def test_reset_usage_rejects_non_staff():
    from fastapi import HTTPException

    from dembrane.api.v2.admin import ResetUsageBody, reset_workspace_usage

    with pytest.raises(HTTPException) as exc:
        await reset_workspace_usage(
            "ws-1", ResetUsageBody(reason="x"), _auth(is_admin=False)
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_reset_usage_stamps_settings_and_audits(mock_directus):
    from dembrane.api.v2.admin import ResetUsageBody, reset_workspace_usage

    mock_directus.get_item = AsyncMock(
        return_value={
            "id": "ws-1",
            "deleted_at": None,
            "org_id": "org-1",
            "settings": {"existing_flag": True},
        }
    )
    mock_directus.update_item = AsyncMock(return_value={"data": {}})

    with patch(
        "dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock
    ), patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock):
        result = await reset_workspace_usage(
            "ws-1", ResetUsageBody(reason="double-counted upload"), _auth()
        )

    assert result["status"] == "ok"
    assert result["usage_reset_at"]
    # The workspace.settings update carried the reset stamp + audit reason and
    # preserved the existing flag.
    args = mock_directus.update_item.await_args
    assert args.args[0] == "workspace"
    settings = args.args[2]["settings"]
    assert settings["existing_flag"] is True
    assert settings["usage_reset_at"] == result["usage_reset_at"]
    assert settings["usage_reset_reason"] == "double-counted upload"
    assert settings["usage_reset_by"] == "staff-1"


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_reset_usage_missing_workspace_404(mock_directus):
    from fastapi import HTTPException

    from dembrane.api.v2.admin import ResetUsageBody, reset_workspace_usage

    mock_directus.get_item = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc:
        await reset_workspace_usage("ws-x", ResetUsageBody(reason="x"), _auth())
    assert exc.value.status_code == 404


# ── members picker ──


@pytest.mark.asyncio
async def test_list_members_rejects_non_staff():
    from fastapi import HTTPException

    from dembrane.api.v2.admin import list_workspace_members

    with pytest.raises(HTTPException) as exc:
        await list_workspace_members("ws-1", _auth(is_admin=False))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_list_members_enriches_users(mock_directus):
    from dembrane.api.v2.admin import list_workspace_members

    async def _get_items(collection, query):
        if collection == "workspace_membership":
            return [
                {"id": "m-1", "user_id": "u-1", "role": "admin"},
                {"id": "m-2", "user_id": "u-2", "role": "member"},
            ]
        if collection == "app_user":
            return [
                {"id": "u-1", "display_name": "Ada", "email": "ada@x.com"},
                {"id": "u-2", "display_name": "Bo", "email": "bo@x.com"},
            ]
        return []

    mock_directus.get_items = AsyncMock(side_effect=_get_items)

    members = await list_workspace_members("ws-1", _auth())
    by_id = {m.membership_id: m for m in members}
    assert by_id["m-1"].display_name == "Ada"
    assert by_id["m-1"].role == "admin"
    assert by_id["m-2"].email == "bo@x.com"
