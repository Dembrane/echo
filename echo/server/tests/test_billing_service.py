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
        # No prior failure flag, so recovery only writes status=active.
        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "payment_failed_notified": False}
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
        mock_mollie.checkout_url = lambda p: "https://pay.mollie/x"

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
    async def test_no_customer_refuses(self, mock_mollie, mock_directus):
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
