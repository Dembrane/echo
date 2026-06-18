"""Reconcile-path coverage: seat reconciliation with discount + pooled seats.

Covers Wave A's reconcile_account_seats invariants extended for ISSUE-024
sub-item 5 (discount applies to the real prorated charge) and tester bug #4
(an existing member creating/joining a workspace is €0 net-new under the pooled
seat model). Mollie + async_directus are mocked.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


class TestReconcileChargesDiscountedProration:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_increase_charges_discounted_one_off(
        self, mock_mollie, mock_directus, mock_seats, mock_fraction
    ):
        from dembrane.billing_service import reconcile_account_seats

        account = {
            "id": "acc-1",
            "status": "active",
            "tier": "changemaker",
            "billing_period": "annual",
            "mollie_subscription_id": "sub_1",
            "mollie_customer_id": "cst_1",
            "percent_discount": 20,
            "provisioned_seats": 1,  # baseline already set
        }
        mock_directus.get_item = AsyncMock(return_value=account)
        mock_directus.update_item = AsyncMock()
        # Live seats jumped from 1 -> 2: one net-new seat to charge.
        mock_seats.return_value = 2
        mock_fraction.return_value = 1.0  # whole period remaining
        mock_mollie.MollieError = Exception
        # sync_subscription_seats path: amount differs, so it PATCHes.
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "0.00"}}
        )
        mock_mollie.update_subscription_amount = AsyncMock()
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"id": "mdt_1", "status": "valid"}]
        )
        mock_mollie.create_recurring_payment = AsyncMock()

        await reconcile_account_seats("acc-1")

        # The recurring re-price is discounted: 75*12*2 = 1800 -> 1440.
        mock_mollie.update_subscription_amount.assert_awaited_once_with(
            customer_id="cst_1", subscription_id="sub_1", amount_eur=1440.0
        )
        # The one-off proration for the +1 seat is discounted: 900 -> 720.
        _, kwargs = mock_mollie.create_recurring_payment.call_args
        assert kwargs["amount_eur"] == 720.0
        # Baseline advanced to the live count after the charge landed.
        patches = [c.args[2] for c in mock_directus.update_item.call_args_list]
        assert {"provisioned_seats": 2} in patches


class TestReconcileNetNewZeroForPooledSeat:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_existing_member_new_workspace_no_charge(
        self, mock_mollie, mock_directus, mock_seats, mock_fraction
    ):
        """Bug #4: an existing seat-holder creating another workspace is €0.

        The pooled count is unchanged (provisioned == current), so reconcile
        re-prices nothing extra and never fires a proration charge."""
        from dembrane.billing_service import reconcile_account_seats

        account = {
            "id": "acc-1",
            "status": "active",
            "tier": "changemaker",
            "billing_period": "annual",
            "mollie_subscription_id": "sub_1",
            "mollie_customer_id": "cst_1",
            "provisioned_seats": 1,
        }
        mock_directus.get_item = AsyncMock(return_value=account)
        mock_directus.update_item = AsyncMock()
        # The creator already held the one seat; pooled count stays 1.
        mock_seats.return_value = 1
        mock_fraction.return_value = 1.0
        mock_mollie.MollieError = Exception
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "900.00"}}  # already correct
        )
        mock_mollie.update_subscription_amount = AsyncMock()
        mock_mollie.create_recurring_payment = AsyncMock()

        await reconcile_account_seats("acc-1")

        # No proration charge — net-new is zero.
        mock_mollie.create_recurring_payment.assert_not_awaited()


class TestReconcileNoopWhenNotActive:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.async_directus")
    async def test_canceled_account_is_noop(self, mock_directus):
        from dembrane.billing_service import reconcile_account_seats

        mock_directus.get_item = AsyncMock(
            return_value={"id": "acc-1", "status": "canceled", "tier": "changemaker"}
        )
        mock_directus.update_item = AsyncMock()

        await reconcile_account_seats("acc-1")
        mock_directus.update_item.assert_not_called()
