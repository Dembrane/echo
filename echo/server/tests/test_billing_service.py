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


class TestResumeSubscription:
    """Resuming a canceled plan must NOT re-charge a period the customer already
    paid for. Within the pre-paid window (with a live mandate) we recreate the
    Mollie subscription starting at the existing period end, no consent charge.
    Outside that window we report resumed=False so the caller starts a fresh
    checkout (Fix C)."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.invalidate_account_usage_caches", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_resume_within_paid_period_recreates_sub_without_charge(
        self, mock_mollie, mock_directus, mock_settings, mock_seats, _mock_inval
    ):
        from dembrane.billing_service import resume_subscription

        mock_settings.return_value.billing.mollie_enabled = True
        mock_settings.return_value.billing.mollie_webhook_url = None
        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "canceled",
                "billing_period": "annual",
                "mollie_customer_id": "cst_1",
                "tier_expires_at": "2099-01-15T00:00:00+00:00",
                "percent_discount": None,
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 1
        mock_mollie.list_mandates = AsyncMock(return_value=[{"id": "mdt_1", "status": "valid"}])
        mock_mollie.create_subscription = AsyncMock(return_value={"id": "sub_new"})
        mock_mollie.create_first_payment = AsyncMock()
        mock_mollie.create_recurring_payment = AsyncMock()

        result = await resume_subscription("acc-1")

        assert result["resumed"] is True
        assert result["status"] == "active"
        # No charge of any kind: the period was already paid.
        mock_mollie.create_first_payment.assert_not_called()
        mock_mollie.create_recurring_payment.assert_not_called()
        # New subscription starts at the existing pre-paid period end.
        _a, kwargs = mock_mollie.create_subscription.call_args
        assert kwargs["start_date"] == "2099-01-15"
        patch_arg = mock_directus.update_item.call_args.args[2]
        assert patch_arg["status"] == "active"
        assert patch_arg["mollie_subscription_id"] == "sub_new"
        assert patch_arg["payment_mode"] == "mollie"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_resume_after_period_lapsed_requires_checkout(
        self, mock_mollie, mock_directus, mock_settings, _mock_seats
    ):
        from dembrane.billing_service import resume_subscription

        mock_settings.return_value.billing.mollie_enabled = True
        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "canceled",
                "billing_period": "annual",
                "mollie_customer_id": "cst_1",
                "tier_expires_at": "2020-01-01T00:00:00+00:00",  # in the past
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.create_subscription = AsyncMock()

        result = await resume_subscription("acc-1")

        assert result["resumed"] is False
        mock_mollie.create_subscription.assert_not_called()
        mock_directus.update_item.assert_not_called()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_resume_without_valid_mandate_requires_checkout(
        self, mock_mollie, mock_directus, mock_settings, _mock_seats
    ):
        from dembrane.billing_service import resume_subscription

        mock_settings.return_value.billing.mollie_enabled = True
        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "canceled",
                "billing_period": "annual",
                "mollie_customer_id": "cst_1",
                "tier_expires_at": "2099-01-15T00:00:00+00:00",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.list_mandates = AsyncMock(return_value=[{"id": "m", "status": "invalid"}])
        mock_mollie.create_subscription = AsyncMock()

        result = await resume_subscription("acc-1")

        assert result["resumed"] is False
        mock_mollie.create_subscription.assert_not_called()


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
    async def test_excludes_method_update_consents(self, mock_mollie, mock_directus):
        # Fix H: the EUR0 "update payment method" consent is a mandate capture,
        # not an invoice. It must not appear in the ledger (and never as a EUR0
        # 'Pay now' row).
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_real",
                    "createdAt": "2026-06-17T09:00:00+00:00",
                    "amount": {"value": "900.00", "currency": "EUR"},
                    "status": "paid",
                    "description": "Changemaker plan.",
                },
                {
                    "id": "tr_method",
                    "createdAt": "2026-06-16T09:00:00+00:00",
                    "amount": {"value": "0.00", "currency": "EUR"},
                    "status": "open",
                    "description": "Update payment method. No charge.",
                    "metadata": {
                        "billing_account_id": "acc-1",
                        "intent": "update_payment_method",
                    },
                    "_links": {"checkout": {"href": "https://pay.mollie/x"}},
                },
            ]
        )

        out = await list_account_invoices("acc-1", limit=20)

        ids = [i["id"] for i in out["invoices"]]
        assert ids == ["tr_real"]  # the method-update consent is hidden

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
    async def test_page_full_of_consents_still_returns_real_invoice(
        self, mock_mollie, mock_directus
    ):
        # Issue 1: when the newest payments are all method-update consents (the
        # user changed their card a few times), the page must NOT come back empty
        # with a phantom "load more"; the real invoice further back must show.
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        method = lambda i: {  # noqa: E731
            "id": f"m{i}",
            "amount": {"value": "0.00", "currency": "EUR"},
            "status": "paid",
            "metadata": {"billing_account_id": "acc-1", "intent": "update_payment_method"},
        }
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                method(1),
                method(2),
                method(3),
                {"id": "tr_real", "amount": {"value": "900.00", "currency": "EUR"}, "status": "paid"},
            ]
        )

        out = await list_account_invoices("acc-1", limit=2)

        assert [i["id"] for i in out["invoices"]] == ["tr_real"]
        assert out["next"] is None  # no phantom "load more"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_paginates_across_a_full_page_of_consents(
        self, mock_mollie, mock_directus
    ):
        # Issue 1: a whole Mollie page of consents must not stop the scan; we pull
        # the next page (Mollie's `from` is inclusive, so the repeated boundary row
        # is dropped) until we have enough displayable rows.
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        page1 = [
            {
                "id": f"m{i}",
                "amount": {"value": "0.00", "currency": "EUR"},
                "status": "paid",
                "metadata": {"billing_account_id": "acc-1", "intent": "update_payment_method"},
            }
            for i in range(50)  # a full Mollie page (== fetch size), all consents
        ]
        page2 = [
            page1[-1],  # inclusive cursor repeats the previous page's last row
            {"id": "real1", "amount": {"value": "900.00", "currency": "EUR"}, "status": "paid"},
            {"id": "real2", "amount": {"value": "900.00", "currency": "EUR"}, "status": "paid"},
            {"id": "real3", "amount": {"value": "900.00", "currency": "EUR"}, "status": "paid"},
        ]
        mock_mollie.list_customer_payments = AsyncMock(side_effect=[page1, page2])

        out = await list_account_invoices("acc-1", limit=2)

        assert [i["id"] for i in out["invoices"]] == ["real1", "real2"]
        assert out["next"] == "real3"  # inclusive cursor for the next page

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


class TestEstimateSeatAdditionFallback:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_added_seats_path_when_no_emails(self, mock_directus, mock_fraction):
        """Without recipient_emails the quote falls back to the raw added_seats
        count (back-compat for callers that don't pass a roster)."""
        from dembrane.billing_service import estimate_seat_addition

        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "active",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "mollie_customer_id": "cst_1",
            }
        )
        mock_fraction.return_value = 1.0

        out = await estimate_seat_addition("acc-1", 2)
        assert out["added_seats"] == 2
        assert out["recurring_delta_eur"] == 1800.0  # 75 * 12 * 2


class TestSeatEstimateWatermark:
    """The invite preview must reflect the high-watermark: filling a seat freed
    earlier this period costs nothing now (only seats beyond the paid-for peak
    are charged); the renewal still rises by every net-new seat."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_filling_freed_seat_is_free_now(
        self, mock_directus, mock_seats, mock_fraction
    ):
        from dembrane.billing_service import estimate_seat_addition

        # Paid for 2 this period (watermark), one left so only 1 is live.
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "active",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "provisioned_seats": 2,
            }
        )
        mock_seats.return_value = 1
        mock_fraction.return_value = 0.5

        out = await estimate_seat_addition("acc-1", 1)

        assert out["active"] is True
        assert out["prorated_now_eur"] == 0.0  # reuses the seat already paid for
        assert out["covered_by_existing_seats"] == 1
        # Renewal still rises by the kept seat.
        assert out["recurring_delta_eur"] == 900.0

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_seat_beyond_watermark_is_charged(
        self, mock_directus, mock_seats, mock_fraction
    ):
        from dembrane.billing_service import estimate_seat_addition

        # Already at the paid-for peak (2 live, watermark 2) -> a new seat charges.
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "active",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "provisioned_seats": 2,
            }
        )
        mock_seats.return_value = 2
        mock_fraction.return_value = 0.5

        out = await estimate_seat_addition("acc-1", 1)

        assert out["covered_by_existing_seats"] == 0
        assert out["prorated_now_eur"] == 450.0  # 900 * 0.5
        assert out["recurring_delta_eur"] == 900.0


class TestDeletionReprices:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.reconcile_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_account_for_workspace", new_callable=AsyncMock)
    @patch("dembrane.api.v2.workspaces.async_directus")
    async def test_delete_workspace_reconciles_after_soft_delete(
        self, mock_directus, mock_get_account, mock_reconcile
    ):
        """ISSUE-010: deleting a workspace re-prices the account immediately
        (after the soft-delete, so the freed seats no longer count) instead of
        waiting for the cron."""
        from types import SimpleNamespace

        from dembrane.api.v2.workspaces import delete_workspace

        # No live projects -> deletion proceeds.
        mock_directus.get_items = AsyncMock(return_value=[{"count": {"id": 0}}])
        mock_directus.update_item = AsyncMock()
        mock_get_account.return_value = {"id": "acc-1"}

        ctx = SimpleNamespace(role="admin", workspace_id="ws-1", app_user_id="u-1")
        out = await delete_workspace(ctx)  # type: ignore[arg-type]

        assert out == {"status": "deleted"}
        # Soft-delete happened...
        soft_delete = mock_directus.update_item.call_args.args
        assert soft_delete[0] == "workspace"
        assert soft_delete[1] == "ws-1"
        assert "deleted_at" in soft_delete[2]
        # ...then the account re-priced.
        mock_reconcile.assert_awaited_once_with("acc-1")


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
        mock_directus.get_items = AsyncMock(return_value=[])  # cache invalidation
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
    async def test_activation_clears_stale_health_flags(self, mock_mollie, mock_directus):
        # Fix G: a reactivated account (e.g. previously past_due, then resumed)
        # must start clean, or a stale payment_failed_notified swallows the next
        # failure notification and reconcile_failed_at shows a phantom prompt.
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
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "free",
                "payment_failed_notified": True,
                "reconcile_failed_at": "2026-01-01T00:00:00+00:00",
            }
        )
        mock_directus.get_items = AsyncMock(return_value=[])
        mock_directus.update_item = AsyncMock()
        mock_mollie.create_subscription = AsyncMock(return_value={"id": "sub_1"})

        await handle_mollie_webhook("tr_1")

        patch_data = mock_directus.update_item.call_args.args[2]
        assert patch_data["payment_failed_notified"] is False
        assert patch_data["reconcile_failed_at"] is None

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_activation_seeds_provisioned_seats_baseline(
        self, mock_mollie, mock_directus
    ):
        # Issue 2: activation must seed provisioned_seats to the seats the first
        # period was billed for. Otherwise the first reconcile after a later
        # seat-add takes the "provisioned is None" baseline path and charges
        # nothing, so the newly-added member rides free until renewal.
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
                    "amount_eur": 1800,
                    "billing_period": "annual",
                    "seats": 2,
                },
            }
        )
        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1", "tier": "free"})
        mock_directus.get_items = AsyncMock(return_value=[])
        mock_directus.update_item = AsyncMock()
        mock_mollie.create_subscription = AsyncMock(return_value={"id": "sub_1"})

        await handle_mollie_webhook("tr_1")

        patch_data = mock_directus.update_item.call_args.args[2]
        assert patch_data["provisioned_seats"] == 2

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
    @patch("dembrane.billing_service._notify_payment_failed", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_recurring_failed_marks_past_due(
        self, mock_mollie, mock_directus, mock_notify
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "subscriptionId": "sub_1",
                "metadata": {"billing_account_id": "acc-1"},
            }
        )
        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_2")

        # past_due is written, and the failed-charge notifier fires (ISSUE-008).
        status_writes = [
            c.args[2]
            for c in mock_directus.update_item.call_args_list
            if c.args[1] == "acc-1"
        ]
        assert {"status": "past_due"} in status_writes
        mock_notify.assert_awaited_once()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_recurring_paid_marks_active(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "subscriptionId": "sub_1",
                "metadata": {"billing_account_id": "acc-1"},
            }
        )
        # No prior failure flag, so recovery only writes status=active.
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "payment_failed_notified": False}
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 2  # live count at renewal

        await handle_mollie_webhook("tr_3")

        writes = [
            c.args[2]
            for c in mock_directus.update_item.call_args_list
            if len(c.args) >= 3 and isinstance(c.args[2], dict)
        ]
        # Renewal recovers the account AND resets the seat watermark to live count.
        assert {"status": "active"} in writes
        assert {"provisioned_seats": 2} in writes

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_no_account_id_is_ignored(self, mock_mollie, mock_directus):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(return_value={"status": "paid", "metadata": {}})
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_x")
        mock_directus.update_item.assert_not_called()


class TestWebhookFirstPaymentFailure:
    """A failed/expired/canceled 'first' payment must only knock a genuinely
    in-flight (pending) new purchase back to 'none'. A method-update consent
    never changes status, and an already-active account is never downgraded by
    a stray failed first payment (Fix A)."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_failed_update_method_payment_leaves_account_untouched(
        self, mock_mollie, mock_directus
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "expired",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {
                    "billing_account_id": "acc-1",
                    "intent": "update_payment_method",
                },
            }
        )
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "active"}
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_1")

        # An abandoned method-change consent must NOT downgrade an active account.
        mock_directus.update_item.assert_not_called()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_failed_first_purchase_on_pending_account_drops_to_none(
        self, mock_mollie, mock_directus
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {"billing_account_id": "acc-1", "intent": "activate"},
            }
        )
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "pending"}
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_1")

        mock_directus.update_item.assert_awaited_once_with(
            "billing_account", "acc-1", {"status": "none"}
        )

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_failed_first_payment_does_not_downgrade_active_account(
        self, mock_mollie, mock_directus
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "canceled",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {"billing_account_id": "acc-1", "intent": "activate"},
            }
        )
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "active"}
        )
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_1")

        mock_directus.update_item.assert_not_called()


# ── ISSUE-024 sub-item 5: discount applies everywhere (incl. real charges) ──


class TestApplyDiscount:
    def test_none_and_zero_are_noop(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, None) == 900.0
        assert apply_discount(900.0, 0) == 900.0

    def test_percentage_reduces(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, 10) == 810.0
        assert apply_discount(1000.0, 25) == 750.0

    def test_hundred_percent_floors_to_zero(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(900.0, 100) == 0.0

    def test_clamps_out_of_range(self):
        from dembrane.billing_service import apply_discount

        # >100 clamps to 100 (free), <0 clamps to 0 (no discount).
        assert apply_discount(900.0, 150) == 0.0
        assert apply_discount(900.0, -20) == 900.0

    def test_rounds_to_cents(self):
        from dembrane.billing_service import apply_discount

        assert apply_discount(99.99, 33) == round(99.99 * 0.67, 2)


class TestDiscountedReprice:
    """sync_subscription_seats sends Mollie the DISCOUNTED amount."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_reprice_uses_discounted_amount(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import sync_subscription_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "active",
                "billing_period": "annual",
                "mollie_subscription_id": "sub_1",
                "mollie_customer_id": "cst_1",
                "percent_discount": 10,
            }
        )
        mock_seats.return_value = 2
        # Mollie currently carries a stale amount so the PATCH is not skipped.
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "0.00", "currency": "EUR"}}
        )
        mock_mollie.update_subscription_amount = AsyncMock()

        amount = await sync_subscription_seats("acc-1")
        # 75 * 12 * 2 = 1800; 10% off = 1620.
        assert amount == 1620.0
        _args, kwargs = mock_mollie.update_subscription_amount.call_args
        assert kwargs["amount_eur"] == 1620.0


class TestDiscountedProration:
    """_charge_seat_proration charges the DISCOUNTED prorated amount."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_proration_is_discounted(self, mock_mollie, mock_fraction):
        from dembrane.billing_service import _charge_seat_proration

        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 0.5
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"status": "valid", "id": "mdt_1"}]
        )
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"id": "tr_x"})

        account = {
            "id": "acc-1",
            "tier": "changemaker",
            "billing_period": "annual",
            "mollie_customer_id": "cst_1",
            "percent_discount": 20,
        }
        result = await _charge_seat_proration(account, added_seats=1)
        # full = 75*12*1 = 900; 20% off = 720; half period = 360.
        assert result == 360.0
        _a, kwargs = mock_mollie.create_recurring_payment.call_args
        assert kwargs["amount_eur"] == 360.0


class TestDiscountedCheckout:
    """start_subscription_checkout creates the first payment at the discounted
    amount, so the recurring subscription (which inherits amount via metadata)
    is also discounted."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._ensure_customer", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    @patch("dembrane.billing_service.get_settings")
    async def test_checkout_amount_is_discounted(
        self, mock_settings, mock_mollie, mock_directus, mock_customer, mock_seats
    ):
        from dembrane.billing_service import start_subscription_checkout

        mock_settings.return_value.billing.mollie_enabled = True
        mock_settings.return_value.billing.mollie_webhook_url = None
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "percent_discount": 50,
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_customer.return_value = "cst_1"
        mock_seats.return_value = 1
        mock_mollie.MollieError = Exception
        mock_mollie.list_customer_payments = AsyncMock(return_value=[])
        mock_mollie.create_first_payment = AsyncMock(return_value={"id": "tr_1"})
        mock_mollie.checkout_url = lambda _p: "https://pay.mollie/x"

        url = await start_subscription_checkout(
            "acc-1", tier="changemaker", billing_period="annual",
            redirect_url="https://app/return",
        )
        assert url == "https://pay.mollie/x"
        _a, kwargs = mock_mollie.create_first_payment.call_args
        # 75*12*1 = 900; 50% off = 450; carried in metadata for the subscription.
        assert kwargs["amount_eur"] == 450.0
        assert kwargs["metadata"]["amount_eur"] == 450.0


# ── ISSUE-002: change payment method (webhook intent gate + revoke) ──────────


class TestUpdatePaymentMethod:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_starts_zero_euro_consent_payment(self, mock_mollie, mock_directus):
        from dembrane.billing_service import start_update_payment_method

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.MollieError = Exception
        mock_mollie.create_first_payment = AsyncMock(
            return_value={"_links": {"checkout": {"href": "https://pay.mollie/x"}}}
        )
        mock_mollie.checkout_url = lambda _p: "https://pay.mollie/x"

        with patch("dembrane.billing_service.get_settings") as mock_settings:
            mock_settings.return_value.billing.mollie_enabled = True
            mock_settings.return_value.billing.mollie_webhook_url = None
            url = await start_update_payment_method("acc-1", redirect_url="https://app/return")

        assert url == "https://pay.mollie/x"
        kwargs = mock_mollie.create_first_payment.call_args.kwargs
        assert kwargs["amount_eur"] == 0.0
        assert kwargs["metadata"]["intent"] == "update_payment_method"
        # A method swap must not flip account status.
        mock_directus.update_item.assert_not_called()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_no_customer_refuses(self, _mock_mollie, mock_directus):
        from dembrane.billing_service import BillingError, start_update_payment_method

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})
        with patch("dembrane.billing_service.get_settings") as mock_settings:
            mock_settings.return_value.billing.mollie_enabled = True
            with pytest.raises(BillingError):
                await start_update_payment_method("acc-1", redirect_url="https://app/return")

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.retry_charge", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_webhook_update_method_revokes_old_and_no_subscription(
        self, mock_mollie, mock_directus, mock_retry
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.MollieError = Exception
        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "sequenceType": "first",
                "customerId": "cst_1",
                "metadata": {
                    "billing_account_id": "acc-1",
                    "intent": "update_payment_method",
                },
            }
        )
        # Two valid mandates: the newest is kept, the older revoked.
        mock_mollie.list_mandates = AsyncMock(
            return_value=[
                {"id": "mdt_new", "status": "valid", "createdAt": "2026-06-18T10:00:00+00:00"},
                {"id": "mdt_old", "status": "valid", "createdAt": "2026-01-01T10:00:00+00:00"},
            ]
        )
        mock_mollie.revoke_mandate = AsyncMock()
        mock_mollie.create_subscription = AsyncMock()
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_upd")

        # Critical: NO second subscription is created (the duplicate-billing gate).
        mock_mollie.create_subscription.assert_not_awaited()
        # The stale mandate is revoked, the newest is kept.
        mock_mollie.revoke_mandate.assert_awaited_once_with("cst_1", "mdt_old")
        # Auto-retry fires on the fresh mandate.
        mock_retry.assert_awaited_once_with("acc-1")

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_sync_ignores_update_method_first_payment(self, mock_mollie, mock_directus):
        from dembrane.billing_service import sync_account_from_mollie

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1", "status": "active"}
        )
        # Only a method-update consent payment exists — must NOT activate.
        mock_mollie.MollieError = Exception
        mock_mollie.list_mandates = AsyncMock(return_value=[])
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "sequenceType": "first",
                    "status": "paid",
                    "metadata": {
                        "billing_account_id": "acc-1",
                        "intent": "update_payment_method",
                    },
                }
            ]
        )
        mock_mollie.create_subscription = AsyncMock()

        status = await sync_account_from_mollie("acc-1")

        assert status == "active"  # unchanged
        mock_mollie.create_subscription.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._revoke_superseded_mandates", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_sync_cleans_up_mandates_after_method_update(
        self, mock_mollie, mock_directus, mock_revoke
    ):
        # Fix E: when a method-update consent has cleared, the return-poll / sync
        # fallback must do the mandate cleanup the webhook would have (in case the
        # webhook was missed), even on an already-subscribed account. It does NOT
        # auto-retry here (repeated syncs must not place repeated charges).
        from dembrane.billing_service import sync_account_from_mollie

        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "mollie_customer_id": "cst_1",
                "mollie_subscription_id": "sub_1",
                "status": "active",
            }
        )
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "sequenceType": "first",
                    "status": "paid",
                    "metadata": {
                        "billing_account_id": "acc-1",
                        "intent": "update_payment_method",
                    },
                }
            ]
        )

        status = await sync_account_from_mollie("acc-1")

        assert status == "active"
        mock_revoke.assert_awaited_once_with("cst_1")


class TestLatestMethodUpdateStatus:
    """The return-from-checkout UI needs the real outcome of a method change:
    the account status doesn't move on a method swap, so a failed/cancelled one
    must not be reported as success."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_returns_newest_method_update_status(self, mock_mollie, mock_directus):
        from dembrane.billing_service import latest_method_update_status

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        # Newest first: a freshly-cancelled attempt over an older successful one.
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_new",
                    "status": "canceled",
                    "metadata": {"billing_account_id": "acc-1", "intent": "update_payment_method"},
                },
                {
                    "id": "tr_old",
                    "status": "paid",
                    "metadata": {"billing_account_id": "acc-1", "intent": "update_payment_method"},
                },
                {"id": "tr_real", "status": "paid", "description": "Changemaker plan."},
            ]
        )

        assert await latest_method_update_status("acc-1") == "canceled"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_none_when_no_method_update_exists(self, mock_mollie, mock_directus):
        from dembrane.billing_service import latest_method_update_status

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[{"id": "tr_real", "status": "paid"}]
        )

        assert await latest_method_update_status("acc-1") is None

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_none_when_no_customer(self, _mock_mollie, mock_directus):
        from dembrane.billing_service import latest_method_update_status

        mock_directus.get_item = AsyncMock(return_value={"id": "acc-1"})

        assert await latest_method_update_status("acc-1") is None


class TestPendingCheckoutUrl:
    """A first purchase the customer didn't finish leaves the account 'pending'
    with an in-flight 'open' consent. We surface that consent's checkout URL so
    they can resume the exact same Mollie payment instead of being stuck."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_returns_open_consent_checkout_url(self, mock_mollie, mock_directus):
        from dembrane.billing_service import pending_checkout_url

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "pending", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.checkout_url = lambda p: (
            ((p.get("_links") or {}).get("checkout") or {}).get("href")
        )
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_open",
                    "sequenceType": "first",
                    "status": "open",
                    "metadata": {"billing_account_id": "acc-1", "intent": "activate"},
                    "_links": {"checkout": {"href": "https://pay.mollie/resume"}},
                }
            ]
        )

        assert await pending_checkout_url("acc-1") == "https://pay.mollie/resume"

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_none_when_not_pending(self, mock_mollie, mock_directus):
        from dembrane.billing_service import pending_checkout_url

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "active", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.list_customer_payments = AsyncMock()

        assert await pending_checkout_url("acc-1") is None
        mock_mollie.list_customer_payments.assert_not_awaited()  # no Mollie call when not pending

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_none_when_no_open_consent(self, mock_mollie, mock_directus):
        from dembrane.billing_service import pending_checkout_url

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "pending", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.MollieError = Exception
        mock_mollie.checkout_url = lambda _p: None
        # Only a settled payment exists; nothing resumable.
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_paid",
                    "sequenceType": "first",
                    "status": "paid",
                    "metadata": {"billing_account_id": "acc-1", "intent": "activate"},
                }
            ]
        )

        assert await pending_checkout_url("acc-1") is None


class TestRevokeSupersededMandates:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.mollie")
    async def test_keeps_newest_revokes_rest(self, mock_mollie):
        from dembrane.billing_service import _revoke_superseded_mandates

        mock_mollie.MollieError = Exception
        mock_mollie.list_mandates = AsyncMock(
            return_value=[
                {"id": "a", "status": "valid", "createdAt": "2026-06-18T00:00:00+00:00"},
                {"id": "b", "status": "valid", "createdAt": "2026-05-01T00:00:00+00:00"},
                {"id": "c", "status": "valid", "createdAt": "2026-04-01T00:00:00+00:00"},
                {"id": "d", "status": "invalid", "createdAt": "2026-06-19T00:00:00+00:00"},
            ]
        )
        mock_mollie.revoke_mandate = AsyncMock()

        revoked = await _revoke_superseded_mandates("cst_1")

        assert revoked == 2
        revoked_ids = {c.args[1] for c in mock_mollie.revoke_mandate.call_args_list}
        assert revoked_ids == {"b", "c"}  # newest valid "a" kept; invalid "d" ignored

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.mollie")
    async def test_single_valid_mandate_is_noop(self, mock_mollie):
        from dembrane.billing_service import _revoke_superseded_mandates

        mock_mollie.MollieError = Exception
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"id": "a", "status": "valid", "createdAt": "2026-06-18T00:00:00+00:00"}]
        )
        mock_mollie.revoke_mandate = AsyncMock()

        revoked = await _revoke_superseded_mandates("cst_1")

        assert revoked == 0
        mock_mollie.revoke_mandate.assert_not_awaited()


# ── ISSUE-003: pay_url on pending/open invoices ──────────────────────────────


class TestPayUrlOnInvoices:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_pay_url_only_on_open_or_pending(self, mock_mollie, mock_directus):
        from dembrane import mollie as real_mollie
        from dembrane.billing_service import list_account_invoices

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "mollie_customer_id": "cst_1"}
        )
        mock_mollie.checkout_url = real_mollie.checkout_url
        mock_mollie.list_customer_payments = AsyncMock(
            return_value=[
                {
                    "id": "tr_open",
                    "status": "open",
                    "amount": {"value": "90.00", "currency": "EUR"},
                    "_links": {"checkout": {"href": "https://pay.mollie/open"}},
                },
                {
                    "id": "tr_pending",
                    "status": "pending",
                    "amount": {"value": "90.00", "currency": "EUR"},
                    "_links": {"checkout": {"href": "https://pay.mollie/pending"}},
                },
                {
                    "id": "tr_paid",
                    "status": "paid",
                    "amount": {"value": "90.00", "currency": "EUR"},
                    "_links": {"checkout": {"href": "https://pay.mollie/paid"}},
                },
            ]
        )

        out = await list_account_invoices("acc-1", limit=20)
        by_id = {i["id"]: i for i in out["invoices"]}
        assert by_id["tr_open"]["pay_url"] == "https://pay.mollie/open"
        assert by_id["tr_pending"]["pay_url"] == "https://pay.mollie/pending"
        # A settled charge has no actionable pay link.
        assert by_id["tr_paid"]["pay_url"] is None


# ── ISSUE-008: failed-charge notification (throttled) + retry/recovery ───────


class TestPaymentFailedNotification:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._email_payment_failed", new_callable=AsyncMock)
    @patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock)
    @patch("dembrane.notifications.audience_billing_account_admins", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_notifies_owner_and_admins_once(
        self, mock_directus, mock_audience, mock_emit, _mock_email
    ):
        from dembrane.billing_service import _notify_payment_failed

        mock_audience.return_value = ["owner-1", "admin-2"]
        mock_emit.return_value = ["n1", "n2"]
        mock_directus.update_item = AsyncMock()

        account = {"id": "acc-1", "workspace_id": "ws-1", "payment_failed_notified": False}
        await _notify_payment_failed(account)

        mock_emit.assert_awaited_once()
        kwargs = mock_emit.call_args.kwargs
        assert kwargs["event_code"] == "PAYMENT_FAILED"
        assert kwargs["action"] == "NAVIGATE_BILLING"
        assert kwargs["ref_workspace_id"] == "ws-1"
        # The throttle flag is set so a repeat failure this cycle won't re-notify.
        mock_directus.update_item.assert_awaited_once_with(
            "billing_account", "acc-1", {"payment_failed_notified": True}
        )

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._email_payment_failed", new_callable=AsyncMock)
    @patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock)
    @patch("dembrane.notifications.audience_billing_account_admins", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_throttled_when_already_notified(
        self, mock_directus, mock_audience, mock_emit, _mock_email
    ):
        from dembrane.billing_service import _notify_payment_failed

        mock_directus.update_item = AsyncMock()
        account = {"id": "acc-1", "workspace_id": "ws-1", "payment_failed_notified": True}

        await _notify_payment_failed(account)

        mock_emit.assert_not_awaited()
        mock_audience.assert_not_awaited()
        mock_directus.update_item.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    async def test_recovery_clears_flag(self, mock_directus):
        from dembrane.billing_service import _mark_recovered

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "payment_failed_notified": True}
        )
        mock_directus.update_item = AsyncMock()

        await _mark_recovered("acc-1")

        patch_data = mock_directus.update_item.call_args.args[2]
        assert patch_data["status"] == "active"
        assert patch_data["payment_failed_notified"] is False


class TestRetryCharge:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_success_marks_active_and_clears_flag(
        self, mock_mollie, mock_directus, mock_seats
    ):
        from dembrane.billing_service import retry_charge

        mock_mollie.MollieError = Exception
        mock_seats.return_value = 1
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "past_due",
                "tier": "changemaker",
                "billing_period": "annual",
                "mollie_customer_id": "cst_1",
                "payment_failed_notified": True,
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"id": "mdt_1", "status": "valid"}]
        )
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"status": "paid"})

        with patch("dembrane.billing_service.get_settings") as mock_settings:
            mock_settings.return_value.billing.mollie_webhook_url = None
            status = await retry_charge("acc-1")

        assert status == "active"
        # Charged against the valid mandate.
        assert mock_mollie.create_recurring_payment.call_args.kwargs["mandate_id"] == "mdt_1"
        # Recovery cleared the throttle flag.
        recovery = mock_directus.update_item.call_args.args[2]
        assert recovery["status"] == "active"
        assert recovery["payment_failed_notified"] is False

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_no_valid_mandate_stays_past_due(self, mock_mollie, mock_directus):
        from dembrane.billing_service import retry_charge

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "past_due",
                "tier": "changemaker",
                "mollie_customer_id": "cst_1",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.list_mandates = AsyncMock(return_value=[{"id": "x", "status": "invalid"}])
        mock_mollie.create_recurring_payment = AsyncMock()

        status = await retry_charge("acc-1")

        assert status == "past_due"
        mock_mollie.create_recurring_payment.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_noop_when_not_past_due(self, mock_mollie, mock_directus):
        from dembrane.billing_service import retry_charge

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "active"}
        )
        mock_mollie.list_mandates = AsyncMock()

        status = await retry_charge("acc-1")

        assert status == "active"
        mock_mollie.list_mandates.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_pending_stays_past_due_until_webhook(
        self, mock_mollie, mock_directus, mock_seats
    ):
        # Fix D: a pending (e.g. SEPA) retry must NOT be treated as recovered;
        # only a settled 'paid' flips active. The webhook confirms settlement.
        from dembrane.billing_service import retry_charge

        mock_mollie.MollieError = Exception
        mock_seats.return_value = 1
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "past_due",
                "tier": "changemaker",
                "billing_period": "annual",
                "mollie_customer_id": "cst_1",
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_mollie.list_mandates = AsyncMock(return_value=[{"id": "mdt_1", "status": "valid"}])
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"status": "pending"})

        with patch("dembrane.billing_service.get_settings") as mock_settings:
            mock_settings.return_value.billing.mollie_webhook_url = None
            status = await retry_charge("acc-1")

        assert status == "past_due"  # not optimistically 'active'
        mock_directus.update_item.assert_not_called()  # no premature recovery


class TestOneOffChargeWebhook:
    """Fix D: one-off mandate charges (retry, seat proration) carry no
    subscriptionId. The webhook must reconcile their settlement by intent, or
    a failed SEPA charge silently leaves a past_due account 'recovered' / lets
    unpaid added seats stick."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._mark_past_due", new_callable=AsyncMock)
    @patch("dembrane.billing_service._mark_recovered", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_charge_paid_marks_recovered(
        self, mock_mollie, _mock_directus, mock_recovered, mock_past_due
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "sequenceType": "recurring",
                "metadata": {"billing_account_id": "acc-1", "intent": "retry_charge"},
            }
        )
        await handle_mollie_webhook("tr_1")
        mock_recovered.assert_awaited_once_with("acc-1")
        mock_past_due.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._mark_past_due", new_callable=AsyncMock)
    @patch("dembrane.billing_service._mark_recovered", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_retry_charge_failed_marks_past_due(
        self, mock_mollie, _mock_directus, mock_recovered, mock_past_due
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "sequenceType": "recurring",
                "metadata": {"billing_account_id": "acc-1", "intent": "retry_charge"},
            }
        )
        await handle_mollie_webhook("tr_1")
        mock_past_due.assert_awaited_once_with("acc-1")
        mock_recovered.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._notify_payment_failed", new_callable=AsyncMock)
    @patch("dembrane.billing_service._set_reconcile_failed", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_failed_proration_rolls_back_baseline_and_flags(
        self, mock_mollie, mock_directus, mock_set_failed, mock_notify
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "failed",
                "sequenceType": "recurring",
                "metadata": {
                    "billing_account_id": "acc-1",
                    "intent": "seat_proration",
                    "provisioned_before": 2,
                },
            }
        )
        account = {"id": "acc-1", "reconcile_failed_at": None}
        mock_directus.get_item = AsyncMock(return_value=account)
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_1")

        # Baseline rolled back so the next reconcile retries the owed charge.
        mock_directus.update_item.assert_awaited_once_with(
            "billing_account", "acc-1", {"provisioned_seats": 2}
        )
        mock_set_failed.assert_awaited_once()
        mock_notify.assert_awaited_once_with(account)


class TestProrationMetadata:
    """Fix D: the proration charge must carry billing_account_id + intent so the
    webhook can route it (it previously used account_id/kind and was dropped at
    the 'no billing_account_id' guard), plus provisioned_before for rollback."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_proration_metadata_is_webhook_routable(self, mock_mollie, mock_fraction):
        from dembrane.billing_service import _charge_seat_proration

        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 1.0
        mock_mollie.list_mandates = AsyncMock(return_value=[{"status": "valid", "id": "mdt_1"}])
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"id": "tr_x"})

        account = {
            "id": "acc-1",
            "tier": "changemaker",
            "billing_period": "annual",
            "mollie_customer_id": "cst_1",
        }
        await _charge_seat_proration(account, added_seats=1, provisioned_before=2)

        meta = mock_mollie.create_recurring_payment.call_args.kwargs["metadata"]
        assert meta["billing_account_id"] == "acc-1"
        assert meta["intent"] == "seat_proration"
        assert meta["provisioned_before"] == 2

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_proration_charge_wires_the_webhook(
        self, mock_mollie, mock_fraction, mock_settings
    ):
        # Routing metadata is useless without a webhookUrl: Mollie only POSTs the
        # webhook (which rolls back the optimistic baseline on a failed/SEPA
        # charge) when the payment carries one.
        from dembrane.billing_service import _charge_seat_proration

        mock_settings.return_value.billing.mollie_webhook_url = "https://hook/mollie"
        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 1.0
        mock_mollie.list_mandates = AsyncMock(return_value=[{"status": "valid", "id": "mdt_1"}])
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"id": "tr_x"})

        account = {
            "id": "acc-1",
            "tier": "changemaker",
            "billing_period": "annual",
            "mollie_customer_id": "cst_1",
        }
        await _charge_seat_proration(account, added_seats=1)

        assert (
            mock_mollie.create_recurring_payment.call_args.kwargs["webhook_url"]
            == "https://hook/mollie"
        )


class TestSeatHighWatermark:
    """A removed seat stays paid-for and reassignable until the period renews:
    leaving doesn't lower the proration baseline (so backfilling it doesn't
    re-charge), and the baseline resets to the live count when a renewal opens
    a new period."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    async def test_leave_keeps_watermark_no_refund_no_recharge(
        self, mock_directus, mock_settings, mock_seats, mock_sync, mock_charge
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_settings.return_value.billing.reconcile_failure_forced = False
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "status": "active",
                "tier": "changemaker",
                "payment_mode": "mollie",
                "mollie_subscription_id": "sub_1",
                "provisioned_seats": 3,  # peak paid-for this period
                "reconcile_failed_at": None,
            }
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 2  # one member left

        await reconcile_account_seats("acc-1")

        # Next renewal is re-priced down...
        mock_sync.assert_awaited_once_with("acc-1")
        # ...but no proration charge and no refund...
        mock_charge.assert_not_called()
        # ...and the watermark is NOT lowered (the freed seat stays paid-for and
        # reassignable until renewal, so a backfill won't re-charge).
        lowered = any(
            len(c.args) >= 3
            and isinstance(c.args[2], dict)
            and "provisioned_seats" in c.args[2]
            for c in mock_directus.update_item.call_args_list
        )
        assert not lowered

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._mark_recovered", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_renewal_resets_watermark_to_live_count(
        self, mock_mollie, mock_directus, mock_seats, mock_recovered
    ):
        from dembrane.billing_service import handle_mollie_webhook

        mock_mollie.get_payment = AsyncMock(
            return_value={
                "status": "paid",
                "sequenceType": "recurring",
                "subscriptionId": "sub_1",
                "metadata": {"billing_account_id": "acc-1"},
            }
        )
        mock_seats.return_value = 5  # live count at renewal
        mock_directus.update_item = AsyncMock()

        await handle_mollie_webhook("tr_1")

        mock_recovered.assert_awaited_once_with("acc-1")
        # New period: baseline resets to the live count, so seats freed last
        # period stop being paid-for.
        mock_directus.update_item.assert_any_await(
            "billing_account", "acc-1", {"provisioned_seats": 5}
        )


# ── Checkout guard: never charge a consent for an account with a subscription ──


class TestCheckoutGuard:
    """Checkout must never run for an account that already has a subscription
    (active or past_due): _activate_from_first_payment no-ops on the existing
    sub, so the customer would be charged with nothing changing."""

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._ensure_customer", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    @patch("dembrane.billing_service.get_settings")
    async def test_checkout_refuses_active_subscription(
        self, mock_settings, mock_mollie, mock_directus, _mock_customer, _mock_seats
    ):
        from dembrane.billing_service import BillingError, start_subscription_checkout

        mock_settings.return_value.billing.mollie_enabled = True
        mock_settings.return_value.billing.mollie_webhook_url = None
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "active",
                "mollie_subscription_id": "sub_1",
            }
        )
        mock_mollie.create_first_payment = AsyncMock()

        with pytest.raises(BillingError):
            await start_subscription_checkout(
                "acc-1", tier="changemaker", billing_period="annual",
                redirect_url="https://app/return",
            )
        # Crucially, no consent payment was created.
        mock_mollie.create_first_payment.assert_not_called()

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._ensure_customer", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    @patch("dembrane.billing_service.get_settings")
    async def test_checkout_refuses_past_due_subscription(
        self, mock_settings, mock_mollie, mock_directus, _mock_customer, _mock_seats
    ):
        # past_due keeps its subscription, so a checkout there would also charge a
        # consent that _activate_from_first_payment no-ops. Block it too.
        from dembrane.billing_service import BillingError, start_subscription_checkout

        mock_settings.return_value.billing.mollie_enabled = True
        mock_settings.return_value.billing.mollie_webhook_url = None
        mock_directus.get_item = AsyncMock(
            return_value={
                "id": "acc-1",
                "tier": "changemaker",
                "status": "past_due",
                "mollie_subscription_id": "sub_1",
            }
        )
        mock_mollie.create_first_payment = AsyncMock()

        with pytest.raises(BillingError):
            await start_subscription_checkout(
                "acc-1", tier="changemaker", billing_period="annual",
                redirect_url="https://app/return",
            )
        mock_mollie.create_first_payment.assert_not_called()
