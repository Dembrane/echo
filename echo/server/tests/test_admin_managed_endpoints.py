"""Tests for the staff managed-billing endpoints (admin_managed.py).

Covers staff gating, set-managed, account-manager @dembrane.com validation, and
that the invoice / pay-link endpoints delegate to billing_service. Endpoint
functions are plain async coroutines, so we call them directly with a fake
DirectusSession rather than spinning up the app.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane.api.dependency_auth import DirectusSession


def _staff() -> DirectusSession:
    return DirectusSession(user_id="staff-1", is_admin=True)


def _non_staff() -> DirectusSession:
    return DirectusSession(user_id="user-1", is_admin=False)


class TestStaffGating:
    @pytest.mark.asyncio
    async def test_set_managed_rejects_non_staff(self):
        from dembrane.api.v2.admin_managed import SetManagedBody, set_managed

        with pytest.raises(HTTPException) as exc:
            await set_managed("acc-1", SetManagedBody(tier="changemaker"), _non_staff())
        assert exc.value.status_code == 403


class TestSetManaged:
    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_flips_to_offline_and_clears_expiry(self, mock_directus):
        from dembrane.api.v2.admin_managed import SetManagedBody, set_managed

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_directus.update_item = AsyncMock()

        out = await set_managed(
            "acc-1", SetManagedBody(tier="guardian", seats=5), _staff()
        )

        assert out["payment_mode"] == "offline"
        patch_data = mock_directus.update_item.call_args.args[2]
        assert patch_data["payment_mode"] == "offline"
        assert patch_data["tier"] == "guardian"
        assert patch_data["status"] == "active"
        assert patch_data["tier_expires_at"] is None  # off the expiry treadmill
        assert patch_data["provisioned_seats"] == 5

    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_with_valid_manager(self, mock_directus):
        from dembrane.api.v2.admin_managed import SetManagedBody, set_managed

        async def fake_get_item(collection, _item_id, **_kw):
            if collection == "billing_account":
                return {"id": "acc-1"}
            return {"id": "mgr-1", "email": "alex@dembrane.com", "display_name": "Alex"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        mock_directus.update_item = AsyncMock()

        await set_managed(
            "acc-1",
            SetManagedBody(tier="changemaker", account_manager_id="mgr-1"),
            _staff(),
        )
        patch_data = mock_directus.update_item.call_args.args[2]
        assert patch_data["account_manager_id"] == "mgr-1"

    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_rejects_non_dembrane_manager(self, mock_directus):
        from dembrane.api.v2.admin_managed import SetManagedBody, set_managed

        async def fake_get_item(collection, _item_id, **_kw):
            if collection == "billing_account":
                return {"id": "acc-1"}
            return {"id": "mgr-1", "email": "alex@gmail.com"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        mock_directus.update_item = AsyncMock()

        with pytest.raises(HTTPException) as exc:
            await set_managed(
                "acc-1",
                SetManagedBody(tier="changemaker", account_manager_id="mgr-1"),
                _staff(),
            )
        assert exc.value.status_code == 400
        mock_directus.update_item.assert_not_called()


class TestAssignAccountManager:
    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_assigns_dembrane_user(self, mock_directus):
        from dembrane.api.v2.admin_managed import AssignManagerBody, assign_account_manager

        async def fake_get_item(collection, _item_id, **_kw):
            if collection == "billing_account":
                return {"id": "acc-1"}
            return {"id": "mgr-1", "email": "sam@dembrane.com", "display_name": "Sam"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        mock_directus.update_item = AsyncMock()

        out = await assign_account_manager(
            "acc-1", AssignManagerBody(account_manager_id="mgr-1"), _staff()
        )
        assert out["account_manager"]["email"] == "sam@dembrane.com"
        assert (
            mock_directus.update_item.call_args.args[2]["account_manager_id"] == "mgr-1"
        )

    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_rejects_external_email(self, mock_directus):
        from dembrane.api.v2.admin_managed import AssignManagerBody, assign_account_manager

        async def fake_get_item(collection, _item_id, **_kw):
            if collection == "billing_account":
                return {"id": "acc-1"}
            return {"id": "mgr-1", "email": "outsider@example.com"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        mock_directus.update_item = AsyncMock()

        with pytest.raises(HTTPException) as exc:
            await assign_account_manager(
                "acc-1", AssignManagerBody(account_manager_id="mgr-1"), _staff()
            )
        assert exc.value.status_code == 400

    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_clear_sets_null(self, mock_directus):
        from dembrane.api.v2.admin_managed import clear_account_manager

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_directus.update_item = AsyncMock()

        await clear_account_manager("acc-1", _staff())
        assert mock_directus.update_item.call_args.args[2] == {"account_manager_id": None}


class TestInvoiceEndpoints:
    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.billing_service")
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_issue_payment_link_delegates(self, mock_directus, mock_service):
        from dembrane.api.v2.admin_managed import IssuePaymentLinkBody, issue_payment_link

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_service.BillingError = Exception
        mock_service.issue_offline_payment_link = AsyncMock(
            return_value={"payment_link_id": "pl_1", "url": "https://pay/x", "amount_eur": 900.0}
        )

        out = await issue_payment_link("acc-1", IssuePaymentLinkBody(), _staff())
        assert out["url"] == "https://pay/x"
        mock_service.issue_offline_payment_link.assert_awaited_once()

    @pytest.mark.asyncio
    @patch("dembrane.api.v2.admin_managed.billing_service")
    @patch("dembrane.api.v2.admin_managed.async_directus")
    async def test_mark_invoice_paid_builds_payment_details(self, mock_directus, mock_service):
        from dembrane.api.v2.admin_managed import MarkInvoicePaidBody, mark_invoice_paid

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_service.BillingError = Exception
        mock_service.issue_sales_invoice = AsyncMock(
            return_value={"invoice_id": "sinv_1", "status": "paid"}
        )

        out = await mark_invoice_paid(
            "acc-1",
            MarkInvoicePaidBody(payment_source="bank-transfer", payment_reference="PO-42"),
            _staff(),
        )
        assert out["status"] == "paid"
        kwargs = mock_service.issue_sales_invoice.call_args.kwargs
        assert kwargs["mark_paid"] is True
        assert kwargs["payment_details"]["source"] == "bank-transfer"
        assert kwargs["payment_details"]["sourceReference"] == "PO-42"
