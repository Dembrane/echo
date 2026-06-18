"""Tests for dembrane.billing_service — Mollie <-> billing_account orchestration.

Covers the per-seat amount math and the webhook reconciliation paths
(first-payment activation, recurring dunning, ignore-unknown).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


class TestPerIntervalAmount:
    def test_changemaker_annual_one_seat(self):
        from dembrane.billing_service import _per_interval_amount

        amount, interval = _per_interval_amount("changemaker", 1, "annual")
        assert amount == 900.0  # 75 * 12 * 1
        assert interval == "12 months"

    def test_changemaker_monthly_two_seats(self):
        from dembrane.billing_service import _per_interval_amount

        amount, interval = _per_interval_amount("changemaker", 2, "monthly")
        assert amount == 180.0  # round(75 * 1.20) * 2
        assert interval == "1 month"

    def test_zero_seats_floors_to_one(self):
        from dembrane.billing_service import _per_interval_amount

        amount, _ = _per_interval_amount("innovator", 0, "annual")
        assert amount == 240.0  # 20 * 12 * 1

    def test_free_is_not_payable(self):
        from dembrane.billing_service import BillingError, _per_interval_amount

        with pytest.raises(BillingError):
            _per_interval_amount("free", 1, "annual")


class TestPlanDescription:
    def test_capitalises_tier_and_states_terms(self):
        from dembrane.billing_service import _plan_description

        d = _plan_description("changemaker", 3, "monthly")
        assert "Changemaker" in d  # capitalised, not "changemaker"
        assert "3 seats" in d
        assert "billed monthly" in d
        assert "Cancel anytime." in d
        assert "—" not in d  # no em dashes (brand rule)
        assert not d.startswith("dembrane")  # no brand prefix on the receipt line

    def test_singular_seat_and_annual(self):
        from dembrane.billing_service import _plan_description

        d = _plan_description("guardian", 1, "annual")
        assert "1 seat," in d
        assert "billed yearly" in d


class TestCancelSubscription:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_cancel_keeps_tier_until_period_end(self, mock_mollie, mock_directus):
        from dembrane.billing_service import cancel_subscription

        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "billing_period": "monthly",
                "mollie_subscription_id": "sub_1",
                "mollie_customer_id": "cst_1",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.MollieError = Exception
        mock_mollie.get_subscription = AsyncMock(
            return_value={"nextPaymentDate": "2026-07-17"}
        )
        mock_mollie.cancel_subscription = AsyncMock(return_value={"status": "canceled"})

        status = await cancel_subscription("acc-1", reason="too_expensive")

        assert status == "canceled"
        mock_mollie.cancel_subscription.assert_awaited_once_with(
            customer_id="cst_1", subscription_id="sub_1"
        )
        patch_arg = mock_directus.update_item.call_args.args[2]
        # Tier is kept (not reverted) — they paid for the period.
        assert "tier" not in patch_arg
        assert patch_arg["status"] == "canceled"
        assert patch_arg["mollie_subscription_id"] is None
        assert patch_arg["tier_expires_at"] == "2026-07-17T00:00:00+00:00"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_no_subscription_is_noop(self, mock_mollie, mock_directus):
        from dembrane.billing_service import cancel_subscription

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1", "tier": "free"})
        mock_directus.update_item = AsyncMock()
        mock_mollie.cancel_subscription = AsyncMock()

        status = await cancel_subscription("acc-1")

        assert status == "free"
        mock_mollie.cancel_subscription.assert_not_called()
        mock_directus.update_item.assert_not_called()


class TestListAccountInvoices:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_maps_all_payment_statuses(self, mock_mollie, mock_directus):
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_1",
                    "createdAt": "2026-06-17T09:00:00+00:00",
                    "amount": {"value": "900.00", "currency": "EUR"},
                    "status": "paid",
                    "description": "Changemaker plan.",
                },
                {
                    "id": "tr_2",
                    "createdAt": "2026-05-17T09:00:00+00:00",
                    "amount": {"value": "900.00", "currency": "EUR"},
                    "status": "canceled",
                    "description": "Changemaker plan.",
                },
            ]
        )

        out = await list_account_invoices("acc-1", limit=20)

        assert [i["status"] for i in out["invoices"]] == ["paid", "canceled"]
        assert out["invoices"][0]["amount"] == "900.00"
        assert out["next"] is None  # fewer than limit -> no next page

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_pagination_cursor_when_more(self, mock_mollie, mock_directus):
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        # limit=1 -> ask for 2; returning 2 means there's a next page.
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {"id": "tr_1", "amount": {"value": "90.00", "currency": "EUR"}, "status": "paid"},
                {"id": "tr_2", "amount": {"value": "90.00", "currency": "EUR"}, "status": "paid"},
            ]
        )

        out = await list_account_invoices("acc-1", limit=1)
        assert len(out["invoices"]) == 1
        assert out["next"] == "tr_2"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_no_customer_returns_empty(self, mock_mollie, mock_directus):
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_mollie.list_customer_payments = AsyncMock()

        out = await list_account_invoices("acc-1")

        assert out == {"invoices": [], "next": None}
        mock_mollie.list_customer_payments.assert_not_called()


class TestEstimateAccountCost:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    async def test_estimate_uses_seat_count(self, mock_seats):
        from dembrane.billing_service import estimate_account_cost

        mock_seats.return_value = 3
        out = await estimate_account_cost("acc-1")

        assert out["seats"] == 3
        cm = out["tiers"]["changemaker"]
        assert cm["annual_per_seat_monthly"] == 75
        assert cm["annual_total_yearly"] == 75 * 12 * 3
        assert cm["monthly_total_monthly"] == 90 * 3  # round(75*1.2)=90
        assert "free" not in out["tiers"]

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    async def test_floor_one_seat(self, mock_seats):
        from dembrane.billing_service import estimate_account_cost

        mock_seats.return_value = 0
        out = await estimate_account_cost("acc-1")
        assert out["seats"] == 1


class TestWebhookActivation:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_first_payment_paid_creates_subscription_and_activates(
        self, mock_mollie, mock_directus
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {
                    "billing_account_id": "acc-1",
                    "intent": "activate",
                    "tier": "changemaker",
                    "interval": "12 months",
                    "amount_eur": 900,
                    "billing_period": "annual",
                },
            }
        )
        # account has no subscription yet
        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1", "tier": "free"})
        mock_directus.update_item = AsyncMock()
        mock_mollie.create_subscription = AsyncMock(return_value={"id": "sub_1"})

        await handle_mollie_webhook("tr_1")

        mock_mollie.create_subscription.assert_awaited_once()
        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert coll == "billing_account"
        assert item_id == "acc-1"
        assert patch_data["status"] == "active"
        assert patch_data["payment_mode"] == "mollie"
        assert patch_data["tier"] == "changemaker"
        assert patch_data["mollie_subscription_id"] == "sub_1"
        assert patch_data["tier_expires_at"] is None  # subscription carries continuity

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_first_payment_idempotent_when_subscription_exists(
        self, mock_mollie, mock_directus
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {"billing_account_id": "acc-1", "tier": "changemaker"},
            }
        )
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_subscription_id": "sub_existing"}
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.create_subscription = AsyncMock()

        await handle_mollie_webhook("tr_1")

        mock_mollie.create_subscription.assert_not_awaited()  # already activated

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_recurring_failed_marks_past_due(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "subscriptionId": "sub_1",
                "metadata": {"billing_account_id": "acc-1"},
            }
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_2")

        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert patch_data == {"status": "past_due"}

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_recurring_paid_marks_active(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "subscriptionId": "sub_1",
                "metadata": {"billing_account_id": "acc-1"},
            }
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_3")
        assert mock_directus.update_item.call_args.args[2] == {"status": "active"}

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_no_account_id_is_ignored(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(return_value={"status": "paid", "metadata": {}})
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_x")
        mock_directus.update_item.assert_not_called()
