"""Tests for slice 14 — tier-upgrade kind through the workspace_request flow.

Covers:
- Old email-only /v2/workspaces/:id/upgrade-request endpoint is removed.
- tier_upgrade kind through POST /v2/workspace-requests with correct validation.
- Approval on tier_upgrade requests changes workspace tier (via admin PATCH).
- Tier picker only offers tiers strictly higher than current (backend tier ordering).
- free is never a valid upgrade target.
- 409 on duplicate in-flight upgrade request (re-tested in context).
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from dembrane.policies import TIER_ORDER
from dembrane.api.v2.workspace_requests import (
    PAID_TIERS,
    SubmitWorkspaceRequest,
    submit_workspace_request,
)

# ── Old endpoint removed ──────────────────────────────────────────────


class TestOldEndpointRemoved:
    """The email-only upgrade-request endpoint is no longer registered."""

    def test_no_request_upgrade_function_in_workspaces(self):
        """The old request_upgrade handler doesn't exist in the workspaces module."""
        from dembrane.api.v2 import workspaces
        assert not hasattr(workspaces, "request_upgrade")

    def test_no_upgrade_request_body_in_workspaces(self):
        """The old UpgradeRequestBody model doesn't exist."""
        from dembrane.api.v2 import workspaces
        assert not hasattr(workspaces, "UpgradeRequestBody")

    def test_no_rate_limiter_for_upgrade_request(self):
        """The rate limiter for the old endpoint is removed."""
        from dembrane.api.v2 import workspaces
        assert not hasattr(workspaces, "_upgrade_request_rate_limiter")

    def test_workspace_router_has_no_upgrade_request_route(self):
        """The /upgrade-request route path is not in the workspace router."""
        from dembrane.api.v2.workspaces import router
        paths = [route.path for route in router.routes]
        for path in paths:
            assert "upgrade-request" not in path


# ── Tier-upgrade submission ───────────────────────────────────────────


def _mock_auth(user_id: str = "du-1", is_admin: bool = False):
    auth = AsyncMock()
    auth.user_id = user_id
    auth.is_admin = is_admin
    return auth


class TestTierUpgradeViaWorkspaceRequests:
    """tier_upgrade kind through the new workspace_request endpoint."""

    @pytest.mark.asyncio
    async def test_workspace_admin_can_submit_tier_upgrade(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="pioneer",
        )
        mock_directus = AsyncMock()

        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "admin"}]
            if collection == "workspace_request":
                return []
            return []

        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value=None)
        app_user = {"id": "au-1", "display_name": "Test", "email": "test@test.com"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=[]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", new_callable=AsyncMock),
        ):
            result = await submit_workspace_request(body, _mock_auth())
        assert result.status == "pending"
        assert result.kind == "tier_upgrade"

    @pytest.mark.asyncio
    async def test_billing_role_can_submit_tier_upgrade(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="innovator",
        )
        mock_directus = AsyncMock()

        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "billing"}]
            if collection == "workspace_request":
                return []
            return []

        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value=None)
        app_user = {"id": "au-1", "display_name": "Test", "email": "test@test.com"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=[]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", new_callable=AsyncMock),
        ):
            result = await submit_workspace_request(body, _mock_auth())
        assert result.status == "pending"
        assert result.kind == "tier_upgrade"

    @pytest.mark.asyncio
    async def test_member_cannot_submit_tier_upgrade(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="pioneer",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[])
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth())
            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_duplicate_pending_upgrade_returns_409(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="innovator",
        )
        mock_directus = AsyncMock()

        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "admin"}]
            if collection == "workspace_request":
                return [{"id": "existing-req", "status": "pending"}]
            return []

        mock_directus.get_items = mock_get_items
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth())
            assert exc_info.value.status_code == 409
            assert "pending" in str(exc_info.value.detail).lower()

    @pytest.mark.asyncio
    async def test_workspace_id_required_for_tier_upgrade(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1",
        )
        mock_directus = AsyncMock()
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth())
            assert exc_info.value.status_code == 400
            assert "workspace_id" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_proposed_tier_sent_in_payload(self):
        """The proposed_tier from the request body is stored in the Directus row."""
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="changemaker",
        )
        mock_directus = AsyncMock()

        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "owner"}]
            if collection == "workspace_request":
                return []
            return []

        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value=None)
        app_user = {"id": "au-1", "display_name": "Test", "email": "t@t.com"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=[]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", new_callable=AsyncMock),
        ):
            await submit_workspace_request(body, _mock_auth())

        call_args = mock_directus.create_item.call_args
        row = call_args[0][1]
        assert row["kind"] == "tier_upgrade"
        assert row["proposed_tier"] == "changemaker"
        assert row["workspace_id"] == "ws-1"
        assert row["org_id"] == "org-1"


# ── Tier picker logic (model constraints) ────────────────────────────


class TestTierPickerConstraints:
    """Tier picker shows only valid upgrade targets."""

    def test_free_not_in_paid_tiers(self):
        """free is never offered as an upgrade target."""
        assert "free" not in PAID_TIERS

    def test_free_rejected_by_model(self):
        """Attempting to propose tier=free raises validation error."""
        with pytest.raises(ValidationError):
            SubmitWorkspaceRequest(
                kind="tier_upgrade", org_id="org-1",
                workspace_id="ws-1", proposed_tier="free",
            )

    def test_all_paid_tiers_are_valid_proposed_tiers(self):
        for tier in ["pilot", "pioneer", "innovator", "changemaker", "guardian"]:
            body = SubmitWorkspaceRequest(
                kind="tier_upgrade", org_id="org-1",
                workspace_id="ws-1", proposed_tier=tier,
            )
            assert body.proposed_tier == tier

    def test_tier_order_has_free_below_all_paid(self):
        """TIER_ORDER positions free at index 0, below all paid tiers."""
        assert TIER_ORDER[0] == "free"
        for paid in PAID_TIERS:
            assert TIER_ORDER.index(paid) > TIER_ORDER.index("free")

    def test_tiers_strictly_higher_logic(self):
        """Verify that tiers above a given tier are correct using TIER_ORDER."""
        idx = TIER_ORDER.index("pilot")
        higher = TIER_ORDER[idx + 1:]
        assert "free" not in higher
        assert "pilot" not in higher
        assert "pioneer" in higher
        assert "innovator" in higher

    def test_tiers_above_pioneer(self):
        idx = TIER_ORDER.index("pioneer")
        higher = TIER_ORDER[idx + 1:]
        assert "free" not in higher
        assert "pilot" not in higher
        assert "pioneer" not in higher
        assert "innovator" in higher
        assert "changemaker" in higher
        assert "guardian" in higher


# ── Approval orchestrator for tier_upgrade ────────────────────────────


class TestApprovalHandlesTierUpgrade:
    """The admin PATCH endpoint handles tier_upgrade kind correctly."""

    @pytest.mark.asyncio
    async def test_approve_tier_upgrade_calls_tier_change(self):
        from dembrane.api.v2.admin import (
            _upgrade_workspace_for_request,
        )

        req = {"id": "req-1", "workspace_id": "ws-1"}
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "tier": "pilot", "org_id": "org-1"})
        mock_directus.update_item = AsyncMock(return_value={"data": {"id": "ws-1"}})

        mock_invalidate_ws = AsyncMock()
        mock_invalidate_org = AsyncMock()

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.cache_utils.invalidate_workspace_usage", mock_invalidate_ws),
            patch("dembrane.cache_utils.invalidate_org_usage", mock_invalidate_org),
        ):
            result = await _upgrade_workspace_for_request(
                req,
                granted_tier="innovator",
                staff_user_id="staff-1",
                granted_tier_expires_at=None,
                granted_type_discount=None,
                granted_percent_discount=None,
            )

        assert result == "ws-1"
        mock_directus.update_item.assert_called_once()
        call_args = mock_directus.update_item.call_args
        assert call_args[0][0] == "workspace"
        assert call_args[0][1] == "ws-1"
        payload = call_args[0][2]
        assert payload["tier"] == "innovator"

    @pytest.mark.asyncio
    async def test_approve_tier_upgrade_with_discount(self):
        from dembrane.api.v2.admin import _upgrade_workspace_for_request

        req = {"id": "req-1", "workspace_id": "ws-1"}

        def _get_item(coll, item_id, *_args, **_kwargs):
            if coll == "billing_account":
                return {"id": item_id, "tier": "pilot"}
            return {"id": "ws-1", "org_id": "org-1", "deleted_at": None, "billing_account_id": "acc-1"}

        mock_admin = AsyncMock()
        mock_admin.get_item = AsyncMock(side_effect=_get_item)
        mock_ba = AsyncMock()
        mock_ba.get_item = AsyncMock(side_effect=_get_item)
        mock_ba.update_item = AsyncMock()

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_admin),
            patch("dembrane.directus_async.async_directus", mock_ba),
            patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock),
            patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock),
        ):
            _result = await _upgrade_workspace_for_request(
                req,
                granted_tier="pioneer",
                staff_user_id="staff-1",
                granted_tier_expires_at=None,
                granted_type_discount="scholarship",
                granted_percent_discount=25,
            )

        # Tier/terms are written to the billing account.
        call_args = mock_ba.update_item.call_args
        assert call_args[0][0] == "billing_account"
        payload = call_args[0][2]
        assert payload["tier"] == "pioneer"
        assert payload["type_discount"] == "scholarship"
        assert payload["percent_discount"] == 25

    @pytest.mark.asyncio
    async def test_decided_request_returns_409(self):
        """Re-deciding an already-decided request returns 409."""
        from dembrane.api.v2.admin import (
            DecideWorkspaceRequestBody,
            decide_workspace_request,
        )

        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={
            "id": "req-1",
            "kind": "tier_upgrade",
            "status": "approved",
            "workspace_id": "ws-1",
            "org_id": "org-1",
            "proposed_tier": "pioneer",
            "requested_by": "au-1",
        })

        staff_user = {"id": "staff-1", "email": "staff@test.com"}
        body = DecideWorkspaceRequestBody(action="approve")
        auth = _mock_auth(is_admin=True)
        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.app_user.get_app_user_or_raise", return_value=staff_user),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await decide_workspace_request("req-1", body, auth)
            assert exc_info.value.status_code == 409
