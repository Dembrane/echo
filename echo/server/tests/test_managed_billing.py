"""Tests for Wave C managed billing (ISSUE-021, 006, 004, 005).

Covers:
- is_managed predicate.
- reconcile on a managed account: records provisioned_seats, never charges.
- managed accounts are skipped by the tier-expiry + pre-warning crons (filter).
- set-managed staff endpoint + account-manager @dembrane.com validation.
- offline pay-link issue + the webhook offline branch (active, no subscription).
- create_sales_invoice issued -> Mollie number; get PDF returns pdfLink.href.
- save billing-details persists VAT/address.
- VAT *rate* behavior is a gated/skipped test (blocked on Marco, ISSUE-005 Q1).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


def _settings_with_mollie(enabled: bool = True, webhook: str | None = None):
    billing = SimpleNamespace(
        mollie_enabled=enabled,
        mollie_webhook_url=webhook,
        mollie_api_key="test_key" if enabled else None,
    )
    return SimpleNamespace(billing=billing)


# ── is_managed predicate ──


class TestIsManaged:
    def test_offline_is_managed(self):
        from dembrane.billing_service import is_managed

        assert is_managed({"payment_mode": "offline"}) is True

    def test_mollie_is_not_managed(self):
        from dembrane.billing_service import is_managed

        assert is_managed({"payment_mode": "mollie"}) is False

    def test_none_account_is_not_managed(self):
        from dembrane.billing_service import is_managed

        assert is_managed(None) is False
        assert is_managed({}) is False


# ── reconcile on a managed account ──


class TestReconcileManaged:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_records_seats_never_charges(self, mock_directus, mock_seats):
        from dembrane.billing_service import reconcile_account_seats

        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "active",
                "tier": "changemaker",
                "billing_period": "annual",
                "payment_mode": "offline",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 4

        with patch("dembrane.billing_service._charge_seat_proration") as mock_charge, patch(
            "dembrane.billing_service.sync_subscription_seats"
        ) as mock_sync:
            mock_charge.side_effect = AssertionError("managed must not charge")
            mock_sync.side_effect = AssertionError("managed must not re-price Mollie")
            await reconcile_account_seats("acc-1")

        # provisioned_seats recorded to the live count, no charge fired.
        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert coll == "billing_account"
        assert item_id == "acc-1"
        assert patch_data == {"provisioned_seats": 4}

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_managed_works_without_mollie_subscription(self, mock_directus, mock_seats):
        from dembrane.billing_service import reconcile_account_seats

        # No mollie_subscription_id: the self-serve path would no-op, but managed
        # still records the seat count.
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-2",
                "status": "active",
                "tier": "guardian",
                "billing_period": "annual",
                "payment_mode": "offline",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 2

        await reconcile_account_seats("acc-2")
        assert mock_directus.update_item.call_args.args[2] == {"provisioned_seats": 2}


class TestManagedNextInvoiceAmount:
    def test_changemaker_annual(self):
        from dembrane.billing_service import managed_next_invoice_amount

        amount = managed_next_invoice_amount(
            {"tier": "changemaker", "billing_period": "annual"}, 2
        )
        assert amount == 1800.0  # 75 * 12 * 2

    def test_free_is_none(self):
        from dembrane.billing_service import managed_next_invoice_amount

        assert managed_next_invoice_amount({"tier": "free"}, 3) is None


# ── crons skip managed (filter assertion) ──


class TestCronSkipsManaged:
    def test_expire_cron_filters_out_offline(self):
        import inspect

        from dembrane import tasks

        # Dramatiq wraps the function in an Actor; read the underlying fn source.
        src = inspect.getsource(tasks.task_expire_workspace_tiers.fn)
        assert '"payment_mode": {"_neq": "offline"}' in src

    def test_prewarning_cron_filters_out_offline(self):
        import inspect

        from dembrane import tasks

        src = inspect.getsource(tasks.task_send_tier_expiry_prewarning.fn)
        assert '"payment_mode": {"_neq": "offline"}' in src


# ── offline pay-link + webhook branch ──


class TestOfflinePaymentLink:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_creates_link_with_offline_intent(
        self, mock_mollie, mock_directus, mock_get_settings, mock_seats
    ):
        from dembrane.billing_service import issue_offline_payment_link

        mock_get_settings.return_value = _settings_with_mollie(enabled=True)
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "billing_period": "annual",
                "payment_mode": "offline",
            }
        )
        mock_seats.return_value = 2
        mock_mollie.create_payment_link = AsyncMock(
            return_value={"id": "pl_1", "_links": {"paymentLink": {"href": "https://pay/x"}}}
        )
        mock_mollie.payment_link_url = lambda link: link["_links"]["paymentLink"]["href"]

        out = await issue_offline_payment_link("acc-1")

        assert out["url"] == "https://pay/x"
        assert out["amount_eur"] == 1800.0  # 75 * 12 * 2
        body = mock_mollie.create_payment_link.call_args.kwargs
        assert body["metadata"]["intent"] == "offline_invoice"
        assert body["metadata"]["billing_account_id"] == "acc-1"


class TestWebhookOfflineBranch:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_offline_paid_marks_active_no_subscription(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "metadata": {"billing_account_id": "acc-1", "intent": "offline_invoice"},
            }
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_offline")

        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert patch_data["status"] == "active"
        assert patch_data["payment_mode"] == "offline"  # stays managed
        assert patch_data["tier_expires_at"] is None
        # No subscription created on the offline path: only the status update ran.
        assert mock_directus.update_item.await_count == 1

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_offline_failed_does_not_downgrade(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "metadata": {"billing_account_id": "acc-1", "intent": "offline_invoice"},
            }
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_offline_fail")
        # Managed: a failed offline payment must NOT touch the account.
        mock_directus.update_item.assert_not_called()


# ── sales invoice (ISSUE-004) ──


class TestSalesInvoice:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_issue_invoice_issued_status_autonumbers(
        self, mock_mollie, mock_directus, mock_get_settings, mock_seats
    ):
        from dembrane.billing_service import issue_sales_invoice

        mock_get_settings.return_value = _settings_with_mollie(enabled=True)
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "guardian",
                "billing_period": "annual",
                "billing_legal_name": "Gov NL",
                "billing_vat_id": "NL123",
                "billing_country": "NL",
            }
        )
        mock_seats.return_value = 1
        # Mollie auto-numbers on issued: it returns the assigned number/status.
        mock_mollie.create_sales_invoice = AsyncMock(
            return_value={"id": "sinv_1", "status": "issued", "invoiceNumber": "2026-0001"}
        )

        out = await issue_sales_invoice("acc-1", mark_paid=False)

        assert out["invoice_id"] == "sinv_1"
        assert out["status"] == "issued"
        kwargs = mock_mollie.create_sales_invoice.call_args.kwargs
        assert kwargs["status"] == "issued"
        assert kwargs["payment_details"] is None  # not paid -> no payment details
        # Captured VAT/address forwarded as the recipient.
        assert kwargs["recipient"]["vatNumber"] == "NL123"
        assert kwargs["recipient"]["organizationName"] == "Gov NL"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_mark_paid_sets_paid_with_payment_details(
        self, mock_mollie, mock_directus, mock_get_settings, mock_seats
    ):
        from dembrane.billing_service import issue_sales_invoice

        mock_get_settings.return_value = _settings_with_mollie(enabled=True)
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "tier": "changemaker", "billing_period": "annual"}
        )
        mock_seats.return_value = 1
        mock_mollie.create_sales_invoice = AsyncMock(
            return_value={"id": "sinv_2", "status": "paid"}
        )

        out = await issue_sales_invoice(
            "acc-1", mark_paid=True, payment_details={"source": "bank-transfer"}
        )

        assert out["status"] == "paid"
        kwargs = mock_mollie.create_sales_invoice.call_args.kwargs
        assert kwargs["status"] == "paid"
        assert kwargs["payment_details"] == {"source": "bank-transfer"}

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.mollie")
    async def test_get_pdf_url_reads_pdflink(self, mock_mollie):
        from dembrane.billing_service import get_sales_invoice_pdf_url

        mock_mollie.get_sales_invoice = AsyncMock(
            return_value={"id": "sinv_1", "_links": {"pdfLink": {"href": "https://pdf/x.pdf"}}}
        )
        mock_mollie.sales_invoice_pdf_url = lambda inv: inv["_links"]["pdfLink"]["href"]

        url = await get_sales_invoice_pdf_url("sinv_1")
        assert url == "https://pdf/x.pdf"


# ── billing details capture (ISSUE-005) ──


class TestBillingDetails:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    async def test_save_persists_known_fields_only(self, mock_directus):
        from dembrane.billing_service import save_billing_details

        mock_directus.update_item = AsyncMock()
        saved = await save_billing_details(
            "acc-1",
            {
                "billing_legal_name": "Gemeente X",
                "billing_vat_id": "NL000",
                "billing_vat_region": "eu",
                "billing_country": "NL",
                "billing_city": "Amsterdam",
                "unknown_field": "ignored",
            },
        )
        assert "unknown_field" not in saved
        assert saved["billing_legal_name"] == "Gemeente X"
        assert saved["billing_vat_region"] == "eu"
        patch_data = mock_directus.update_item.call_args.args[2]
        assert "unknown_field" not in patch_data

    def test_billing_details_from_account_reads_all_fields(self):
        from dembrane.billing_service import (
            BILLING_DETAIL_FIELDS,
            billing_details_from_account,
        )

        acc = {f: f"v-{f}" for f in BILLING_DETAIL_FIELDS}
        out = billing_details_from_account(acc)
        assert out == acc


# ── overview surfaces managed state ──


class TestManagedOverview:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_managed_overview_skips_mollie_and_shows_manager(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import get_billing_overview

        account = {
            "id": "acc-1",
            "tier": "guardian",
            "billing_period": "annual",
            "status": "active",
            "payment_mode": "offline",
            "account_manager_id": "mgr-1",
            "billing_legal_name": "Gov NL",
            "billing_vat_id": "NL123",
            "billing_vat_region": "eu",
        }

        async def fake_get_item(collection, _item_id, **_kw):
            if collection == "billing_account":
                return account
            return {"id": "mgr-1", "email": "sam@dembrane.com", "display_name": "Sam"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        # Pending-invite lookup (Wave A) walks the account's workspaces; a managed
        # account still surfaces pending invites, so the overview hits get_items.
        # No workspaces here means no pending invites.
        mock_directus.get_items = AsyncMock(return_value=[])
        mock_seats.return_value = 3
        # Mollie methods must never be called for a managed account.
        mock_mollie.get_subscription = AsyncMock(
            side_effect=AssertionError("managed must not hit Mollie subscription")
        )
        mock_mollie.list_mandates = AsyncMock(
            side_effect=AssertionError("managed must not hit Mollie mandates")
        )
        mock_mollie.MollieError = Exception

        out = await get_billing_overview("acc-1")

        assert out["is_managed"] is True
        assert out["account_manager"] == {"name": "Sam", "email": "sam@dembrane.com"}
        assert out["billing_details"]["billing_vat_id"] == "NL123"
        assert out["billing_details"]["billing_vat_region"] == "eu"
        # Next invoice is derived live from the seat count, not from Mollie.
        assert out["next_invoice"]["amount"] == "5400.00"  # guardian 150 * 12 * 3
        assert out["payment_method"] is None


# ── VAT rate behaviour: gated on Marco (ISSUE-005 Q1) ──


@pytest.mark.skip(reason="VAT rate / reverse-charge ruleset blocked on Marco (ISSUE-005 Q1)")
def test_vat_rate_reverse_charge_treatment():
    """When the legal ruleset lands: an EU business with a valid VAT ID gets
    reverse-charge (btw verlegd) at 0%, a domestic buyer gets the domestic rate,
    prices quoted excl. VAT. Do not implement guessed rates."""
    raise NotImplementedError
