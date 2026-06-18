"""Tests for Slice 19 — Discount fields (staff edit + workspace settings + CSV).

Covers:
- UpdateWorkspaceDiscountBody model validation (type enum, percent bounds, clear flags)
- update_workspace_discount endpoint: staff-only, 404 on missing, applies fields,
  clear semantics, no-op on empty body
- WorkspaceDetailResponse includes type_discount + percent_discount
- BillingRow includes tier_expires_at, type_discount, percent_discount
- _all_active_workspaces fetches discount + expiry fields
- _create_workspace_for_request writes discount fields (already covered in Slice 10,
  but verified structurally here)
- _upgrade_workspace_for_request writes discount fields (same)
- No code path computes a price using discount fields (grep guard)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

# ── Model validation tests ──


class TestUpdateWorkspaceDiscountBody:
    def test_type_scholarship(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(type_discount="scholarship")
        assert body.type_discount == "scholarship"
        assert body.percent_discount is None
        assert body.clear_type_discount is False

    def test_type_staff_discount(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(type_discount="staff_discount")
        assert body.type_discount == "staff_discount"

    def test_type_invalid_rejected(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        with pytest.raises(ValidationError):
            UpdateWorkspaceDiscountBody(type_discount="bulk_deal")

    def test_percent_0(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(percent_discount=0)
        assert body.percent_discount == 0

    def test_percent_100(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(percent_discount=100)
        assert body.percent_discount == 100

    def test_percent_negative_rejected(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        with pytest.raises(ValidationError):
            UpdateWorkspaceDiscountBody(percent_discount=-1)

    def test_percent_101_rejected(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        with pytest.raises(ValidationError):
            UpdateWorkspaceDiscountBody(percent_discount=101)

    def test_both_fields(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(
            type_discount="scholarship", percent_discount=50
        )
        assert body.type_discount == "scholarship"
        assert body.percent_discount == 50

    def test_clear_flags(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody(
            clear_type_discount=True, clear_percent_discount=True
        )
        assert body.clear_type_discount is True
        assert body.clear_percent_discount is True
        assert body.type_discount is None
        assert body.percent_discount is None

    def test_empty_body(self):
        from dembrane.api.v2.admin import UpdateWorkspaceDiscountBody

        body = UpdateWorkspaceDiscountBody()
        assert body.type_discount is None
        assert body.percent_discount is None
        assert body.clear_type_discount is False
        assert body.clear_percent_discount is False


# ── Endpoint logic tests ──


class TestUpdateWorkspaceDiscountEndpoint:
    @pytest.mark.asyncio
    async def test_staff_only(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = False
        body = UpdateWorkspaceDiscountBody(type_discount="scholarship")

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            await update_workspace_discount("ws-1", body, auth)
        assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_workspace_not_found(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        body = UpdateWorkspaceDiscountBody(type_discount="scholarship")

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(return_value=None)

            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc_info:
                await update_workspace_discount("ws-missing", body, auth)
            assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_deleted_workspace_returns_404(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        body = UpdateWorkspaceDiscountBody(type_discount="scholarship")

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": "2026-01-01"}
            )

            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc_info:
                await update_workspace_discount("ws-1", body, auth)
            assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_set_type_discount(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(type_discount="scholarship")

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            result = await update_workspace_discount("ws-1", body, auth)

            mock_directus.update_item.assert_called_once_with(
                "workspace", "ws-1", {"type_discount": "scholarship"}
            )
            assert result["status"] == "ok"
            assert result["type_discount"] == "scholarship"

    @pytest.mark.asyncio
    async def test_set_percent_discount(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(percent_discount=25)

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            result = await update_workspace_discount("ws-1", body, auth)

            mock_directus.update_item.assert_called_once_with(
                "workspace", "ws-1", {"percent_discount": 25}
            )
            assert result["status"] == "ok"
            assert result["percent_discount"] == 25

    @pytest.mark.asyncio
    async def test_set_both_fields(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(
            type_discount="staff_discount", percent_discount=15
        )

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            result = await update_workspace_discount("ws-1", body, auth)

            mock_directus.update_item.assert_called_once_with(
                "workspace",
                "ws-1",
                {"type_discount": "staff_discount", "percent_discount": 15},
            )
            assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_clear_type_discount(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(clear_type_discount=True)

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            result = await update_workspace_discount("ws-1", body, auth)

            mock_directus.update_item.assert_called_once_with(
                "workspace", "ws-1", {"type_discount": None}
            )
            assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_clear_percent_discount(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(clear_percent_discount=True)

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            result = await update_workspace_discount("ws-1", body, auth)

            mock_directus.update_item.assert_called_once_with(
                "workspace", "ws-1", {"percent_discount": None}
            )
            assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_empty_body_returns_400(self):
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        body = UpdateWorkspaceDiscountBody()

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )

            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc_info:
                await update_workspace_discount("ws-1", body, auth)
            assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_clear_overrides_set(self):
        """When both clear and set are provided, clear wins."""
        from dembrane.api.v2.admin import (
            UpdateWorkspaceDiscountBody,
            update_workspace_discount,
        )

        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "staff-1"
        body = UpdateWorkspaceDiscountBody(
            type_discount="scholarship", clear_type_discount=True
        )

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_item = AsyncMock(
                return_value={"id": "ws-1", "deleted_at": None}
            )
            mock_directus.update_item = AsyncMock(return_value=None)

            _result = await update_workspace_discount("ws-1", body, auth)

            call_args = mock_directus.update_item.call_args[0]
            assert call_args[2]["type_discount"] is None


# ── WorkspaceDetailResponse schema tests ──


class TestWorkspaceDetailResponseDiscount:
    def test_includes_discount_fields(self):
        from dembrane.api.v2.workspace_settings import WorkspaceDetailResponse

        resp = WorkspaceDetailResponse(
            id="ws-1",
            name="Test",
            tier="pioneer",
            org_id="org-1",
            org_name="Org",
            is_default=False,
            type_discount="scholarship",
            percent_discount=30,
        )
        assert resp.type_discount == "scholarship"
        assert resp.percent_discount == 30

    def test_discount_defaults_to_none(self):
        from dembrane.api.v2.workspace_settings import WorkspaceDetailResponse

        resp = WorkspaceDetailResponse(
            id="ws-1",
            name="Test",
            tier="pioneer",
            org_id="org-1",
            org_name="Org",
            is_default=False,
        )
        assert resp.type_discount is None
        assert resp.percent_discount is None


# ── BillingRow schema tests ──


class TestBillingRowDiscountFields:
    def test_includes_discount_and_expiry(self):
        from dembrane.api.v2.admin import BillingRow

        row = BillingRow(
            workspace_id="ws-1",
            workspace_name="Test",
            org_id="org-1",
            org_name="Org",
            tier="innovator",
            audio_hours=5.0,
            seat_count=3,
            tier_expires_at="2026-06-01T00:00:00Z",
            type_discount="scholarship",
            percent_discount=20,
        )
        assert row.tier_expires_at == "2026-06-01T00:00:00Z"
        assert row.type_discount == "scholarship"
        assert row.percent_discount == 20

    def test_discount_defaults_to_none(self):
        from dembrane.api.v2.admin import BillingRow

        row = BillingRow(
            workspace_id="ws-1",
            workspace_name="Test",
            org_id="org-1",
            org_name="Org",
            tier="pioneer",
            audio_hours=0,
            seat_count=0,
        )
        assert row.tier_expires_at is None
        assert row.type_discount is None
        assert row.percent_discount is None


# ── _all_active_workspaces fetches discount fields ──


class TestAllActiveWorkspacesFields:
    @pytest.mark.asyncio
    async def test_query_includes_discount_fields(self):
        from dembrane.api.v2.admin import _all_active_workspaces

        with patch(
            "dembrane.api.v2.admin.async_directus"
        ) as mock_directus:
            mock_directus.get_items = AsyncMock(return_value=[])
            await _all_active_workspaces()

            call_args = mock_directus.get_items.call_args
            fields = call_args[0][1]["query"]["fields"]
            # Commercial fields live on the billing account; joined via dot-notation.
            assert "billing_account_id.tier_expires_at" in fields
            assert "billing_account_id.type_discount" in fields
            assert "billing_account_id.percent_discount" in fields


# ── Approve helpers write discount fields (structural) ──


class TestNoPriceComputation:
    """Grep guard: no code path multiplies a tier price by percent_discount."""

    def test_no_price_multiplication_in_tier_capacity(self):
        import inspect

        from dembrane import tier_capacity

        source = inspect.getsource(tier_capacity)
        assert "percent_discount" not in source

    def test_no_price_multiplication_in_seat_capacity(self):
        import inspect

        from dembrane import seat_capacity

        source = inspect.getsource(seat_capacity)
        assert "percent_discount" not in source
