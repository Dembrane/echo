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


class TestApplyDiscount:
    def test_none_and_zero_are_noops(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, None) == 900.0
        assert apply_discount(900.0, 0) == 900.0

    def test_percent_reduces_and_rounds(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, 10) == 810.0
        assert apply_discount(75.0, 33) == 50.25

    def test_hundred_floors_to_zero(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, 100) == 0.0

    def test_out_of_range_is_clamped(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, 150) == 0.0  # clamps to 100%
        assert apply_discount(900.0, -10) == 900.0  # clamps to 0%


class TestPerIntervalDiscount:
    def test_annual_discounted(self):
        from dembrane.billing_service import _per_interval_amount

        full, interval = _per_interval_amount("changemaker", 2, "annual")
        disc, _ = _per_interval_amount("changemaker", 2, "annual", 25)
        assert full == 75 * 12 * 2  # 1800
        assert disc == 1350.0  # 1800 * 0.75
        assert interval == "12 months"

    def test_monthly_discounted(self):
        from dembrane.billing_service import _per_interval_amount

        disc, _ = _per_interval_amount("changemaker", 1, "monthly", 50)
        # monthly per-seat = round(75*1.2)=90; *1 seat; *0.5 = 45
        assert disc == 45.0


class TestSyncSubscriptionSeatsDiscount:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_repriced_amount_is_discounted(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import sync_subscription_seats

        mock_seats.return_value = 2
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "active",
                "tier": "changemaker",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "mollie_customer_id": "cst_1",
                "percent_discount": 25,
            }
        )
        mock_mollie.MollieError = Exception
        # Mollie currently shows the old undiscounted amount, forcing a PATCH.
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "1800.00"}}
        )
        mock_mollie.update_subscription_amount = AsyncMock()

        amount = await sync_subscription_seats("acc-1")

        # 75 * 12 * 2 = 1800, discounted 25% -> 1350. This is the LIVE Mollie charge.
        assert amount == 1350.0
        mock_mollie.update_subscription_amount.assert_awaited_once_with(
            customer_id="cst_1", subscription_id="sub_1", amount_eur=1350.0
        )


class TestChargeProrationDiscount:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_prorated_one_off_is_discounted(self, mock_mollie, mock_fraction):
        from dembrane.billing_service import _charge_seat_proration

        mock_fraction.return_value = 0.5  # half the period remaining
        mock_mollie.MollieError = Exception
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"id": "mdt_1", "status": "valid"}]
        )
        mock_mollie.create_recurring_payment = AsyncMock()

        account = {
            "id": "acc-1",
            "tier": "changemaker",
            "mollie_customer_id": "cst_1",
            "billing_period": "annual",
            "percent_discount": 20,
        }
        charged = await _charge_seat_proration(account, added_seats=1)

        # full added = 75*12 = 900, discounted 20% -> 720, prorated *0.5 -> 360.
        assert charged == 360.0
        _, kwargs = mock_mollie.create_recurring_payment.call_args
        assert kwargs["amount_eur"] == 360.0


class TestEstimateSeatAdditionDiscount:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_estimate_carries_discount(self, mock_directus, mock_fraction):
        from dembrane.billing_service import estimate_seat_addition

        mock_fraction.return_value = 1.0
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "active",
                "tier": "changemaker",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "percent_discount": 10,
            }
        )
        out = await estimate_seat_addition("acc-1", 1)
        assert out["active"] is True
        # 900 * 0.9 = 810
        assert out["recurring_delta_eur"] == 810.0
        assert out["prorated_now_eur"] == 810.0


class TestBillingOverviewDiscount:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_projected_and_next_invoice_discounted(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import get_billing_overview

        mock_seats.return_value = 2
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "billing_period": "annual",
                "status": "active",
                "mollie_customer_id": "cst_1",
                "mollie_subscription_id": "sub_1",
                "percent_discount": 25,
            }
        )
        mock_mollie.MollieError = Exception
        mock_mollie.get_subscription = AsyncMock(
            return_value={
                "amount": {"value": "1800.00", "currency": "EUR"},
                "nextPaymentDate": "2026-12-01",
            }
        )
        mock_mollie.list_mandates = AsyncMock(return_value=[])

        out = await get_billing_overview("acc-1")

        # projected_monthly: 75/seat * 2 = 150, discounted 25% -> 112.5
        assert out["projected_monthly_eur"] == 112.5
        # per_seat stays at sticker (75); discount carried on the totals.
        assert out["per_seat_monthly_eur"] == 75
        # next invoice (annual renewal) = 1800 discounted -> 1350.00, displayed.
        assert out["next_invoice"]["amount"] == "1350.00"
        assert out["percent_discount"] == 25


class TestCountAccountSeatsPooled:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._seat_user_ids", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_same_user_across_workspaces_counts_once(
        self, mock_directus, mock_seat_users
    ):
        from dembrane.billing_service import count_account_seats

        mock_directus.get_items = AsyncMock(
            return_value=[{"id": "ws-1"}, {"id": "ws-2"}]
        )
        # u1 is a member of BOTH workspaces; u2 only of ws-2.
        mock_seat_users.side_effect = [
            {"u1"},  # ws-1
            {"u1", "u2"},  # ws-2
        ]
        total = await count_account_seats("acc-1")
        # Pooled: distinct users {u1, u2} = 2, NOT 1 + 2 = 3.
        assert total == 2

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._seat_user_ids", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_existing_member_new_workspace_is_zero_net_new(
        self, mock_directus, mock_seat_users
    ):
        """Tester bug #4: an existing member creating a new workspace adds €0.

        Before the new workspace, the account had {u1}. The new workspace adds
        u1 as owner. Pooled count stays 1 -> net-new 0 -> reconcile charges
        nothing."""
        from dembrane.billing_service import count_account_seats

        # Two workspaces now exist; u1 owns both.
        mock_directus.get_items = AsyncMock(
            return_value=[{"id": "ws-existing"}, {"id": "ws-new"}]
        )
        mock_seat_users.side_effect = [{"u1"}, {"u1"}]
        total = await count_account_seats("acc-1")
        assert total == 1  # was 1 before the new workspace; unchanged.
        mock_directus.update_item.assert_not_called()
