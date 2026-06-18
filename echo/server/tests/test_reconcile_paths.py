"""Wave A: seat-reconcile integrity (ISSUE-001 / 007 / 010).

The guarantee under test: the amount we quote/display equals the amount Mollie
actually charges, on every seat path. So:

  - reconcile re-prices the subscription and prorates added seats exactly once
    (tracked by provisioned_seats), both on increase and decrease,
  - a Mollie failure (re-price error OR dead/invalid mandate) sets the
    observable flag reconcile_failed_at, does NOT advance provisioned_seats, and
    does NOT re-raise; a clean pass clears the flag,
  - the net-new quote dedupes recipients already seated/pending on the account
    (founder rule A1: an existing active member costs EUR0),
  - the overview shows Mollie's stored amount and surfaces pending invites.

Mollie + async_directus are mocked (same @patch(...AsyncMock) style as
test_billing_service.py).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


def _active_account(**overrides) -> dict:
    base = {
        "id": "acc-1",
        "tier": "changemaker",
        "status": "active",
        "billing_period": "annual",
        "mollie_subscription_id": "sub_1",
        "mollie_customer_id": "cst_1",
        "provisioned_seats": 1,
        "reconcile_failed_at": None,
    }
    base.update(overrides)
    return base


# ── reconcile: re-price + single proration ──────────────────────────────


class TestReconcileReprices:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_increase_reprices_and_charges_once(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account(provisioned_seats=1))
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 3  # grew from 1 -> 3
        mock_charge.return_value = 50.0  # charge landed

        await reconcile_account_seats("acc-1")

        # Always re-prices the subscription so the renewal matches live seats.
        mock_sync.assert_awaited_once_with("acc-1")
        # Prorates exactly the 2 net-new seats, once.
        mock_charge.assert_awaited_once()
        assert mock_charge.call_args.args[1] == 2
        # Baseline advances to the charged count (no double-charge on re-run).
        prov_writes = [
            c.args[2]["provisioned_seats"]
            for c in mock_directus.update_item.call_args_list
            if "provisioned_seats" in c.args[2]
        ]
        assert prov_writes == [3]

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_decrease_reprices_no_refund(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account(provisioned_seats=3))
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 1  # dropped from 3 -> 1

        await reconcile_account_seats("acc-1")

        mock_sync.assert_awaited_once_with("acc-1")
        # Removal takes effect at renewal only: no proration charge.
        mock_charge.assert_not_awaited()
        prov_writes = [
            c.args[2]["provisioned_seats"]
            for c in mock_directus.update_item.call_args_list
            if "provisioned_seats" in c.args[2]
        ]
        assert prov_writes == [1]

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_first_reconcile_sets_baseline_no_charge(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account(provisioned_seats=None))
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 5

        await reconcile_account_seats("acc-1")

        # Always re-prices first, even on the baseline-setting run.
        mock_sync.assert_awaited_once_with("acc-1")
        # First run just records the baseline; never charges for pre-existing seats.
        mock_charge.assert_not_awaited()
        prov_writes = [
            c.args[2]["provisioned_seats"]
            for c in mock_directus.update_item.call_args_list
            if "provisioned_seats" in c.args[2]
        ]
        assert prov_writes == [5]


# ── reconcile: failure flag contract (A2) ───────────────────────────────


class TestReconcileFailureFlag:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_dead_mandate_sets_flag_no_baseline_advance_no_raise(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import ReconcileChargeError, reconcile_account_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account(provisioned_seats=1))
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 2  # a seat was added; a charge is owed
        mock_charge.side_effect = ReconcileChargeError("dead mandate")

        # Must NOT raise: a billing hiccup never blocks collaboration.
        await reconcile_account_seats("acc-1")

        # The re-price ran (it is what keeps the renewal correct); only the
        # one-off proration charge failed.
        mock_sync.assert_awaited_once_with("acc-1")
        writes = {
            k: v
            for c in mock_directus.update_item.call_args_list
            for k, v in c.args[2].items()
        }
        # Flag set...
        assert "reconcile_failed_at" in writes
        assert writes["reconcile_failed_at"] is not None
        # ...and the baseline did NOT advance (retries next reconcile).
        assert "provisioned_seats" not in writes

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_reprice_error_sets_flag(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = RuntimeError
        mock_directus.get_item = AsyncMock(return_value=_active_account(provisioned_seats=1))
        mock_directus.update_item = AsyncMock()
        # The Mollie PATCH inside sync_subscription_seats blew up.
        mock_sync.side_effect = RuntimeError("Mollie 422 re-price")
        mock_seats.return_value = 2

        await reconcile_account_seats("acc-1")

        writes = {
            k: v
            for c in mock_directus.update_item.call_args_list
            for k, v in c.args[2].items()
        }
        assert writes.get("reconcile_failed_at") is not None
        assert "provisioned_seats" not in writes
        mock_charge.assert_not_awaited()  # never reached the charge step

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_clean_pass_clears_existing_flag(
        self, mock_mollie, mock_directus, mock_sync, mock_charge, mock_seats
    ):
        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = Exception
        # Account was previously flagged.
        mock_directus.get_item = AsyncMock(
            return_value=_active_account(
                provisioned_seats=2, reconcile_failed_at="2026-06-17T00:00:00+00:00"
            )
        )
        mock_directus.update_item = AsyncMock()
        mock_seats.return_value = 2  # in line; nothing to charge

        await reconcile_account_seats("acc-1")

        mock_sync.assert_awaited_once_with("acc-1")
        mock_charge.assert_not_awaited()  # seats in line; nothing to charge
        writes = {
            k: v
            for c in mock_directus.update_item.call_args_list
            for k, v in c.args[2].items()
        }
        # Recovery clears the flag back to null.
        assert "reconcile_failed_at" in writes
        assert writes["reconcile_failed_at"] is None


class TestForcedReconcileFailure:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.get_settings")
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_force_flag_sets_reconcile_failed_and_skips_mollie(
        self, mock_mollie, mock_directus, mock_settings, mock_sync
    ):
        """A2: the MOLLIE_FORCE_RECONCILE_FAILURE test toggle flags the account
        without touching Mollie, so the failure path can be exercised on demand."""
        from types import SimpleNamespace

        from dembrane.billing_service import reconcile_account_seats

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account())
        mock_directus.update_item = AsyncMock()
        mock_settings.return_value = SimpleNamespace(
            billing=SimpleNamespace(reconcile_failure_forced=True)
        )

        await reconcile_account_seats("acc-1")

        # Bailed before re-pricing or counting seats.
        mock_sync.assert_not_awaited()
        writes = {
            k: v
            for c in mock_directus.update_item.call_args_list
            for k, v in c.args[2].items()
        }
        assert writes.get("reconcile_failed_at") is not None
        assert "provisioned_seats" not in writes


# ── _charge_seat_proration: failure vs no-op distinction ─────────────────


class TestChargeProrationSignalsFailure:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_no_valid_mandate_raises(self, mock_mollie, mock_fraction):
        from dembrane.billing_service import ReconcileChargeError, _charge_seat_proration

        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 0.5
        mock_mollie.list_mandates = AsyncMock(return_value=[{"status": "invalid"}])

        with pytest.raises(ReconcileChargeError):
            await _charge_seat_proration(_active_account(), added_seats=1)

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_no_remaining_period_is_noop_not_failure(
        self, mock_mollie, mock_fraction
    ):
        from dembrane.billing_service import _charge_seat_proration

        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 0.0  # at/after renewal: nothing to prorate

        # No raise, returns None (legitimate no-op, must not flag the account).
        result = await _charge_seat_proration(_active_account(), added_seats=1)
        assert result is None

    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.mollie")
    async def test_charge_lands_returns_amount(self, mock_mollie, mock_fraction):
        from dembrane.billing_service import _charge_seat_proration

        mock_mollie.MollieError = Exception
        mock_fraction.return_value = 0.5  # half the annual period left
        mock_mollie.list_mandates = AsyncMock(
            return_value=[{"status": "valid", "id": "mdt_1"}]
        )
        mock_mollie.create_recurring_payment = AsyncMock(return_value={"id": "tr_x"})

        # changemaker annual: 75 * 12 * 1 = 900; half = 450.
        result = await _charge_seat_proration(_active_account(), added_seats=1)
        assert result == 450.0
        mock_mollie.create_recurring_payment.assert_awaited_once()


# ── net-new dedupe (007 / A1) ────────────────────────────────────────────


class TestNetNewSeats:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.account_pending_invite_emails", new_callable=AsyncMock)
    @patch("dembrane.billing_service.account_active_seat_emails", new_callable=AsyncMock)
    async def test_existing_member_is_zero_net_new(self, mock_active, mock_pending):
        from dembrane.billing_service import count_net_new_seats

        mock_active.return_value = {"alice@x.com"}
        mock_pending.return_value = set()

        # Alice already holds a seat -> 0 net-new (founder rule A1).
        assert await count_net_new_seats("acc-1", ["Alice@X.com"]) == 0

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.account_pending_invite_emails", new_callable=AsyncMock)
    @patch("dembrane.billing_service.account_active_seat_emails", new_callable=AsyncMock)
    async def test_dedupes_active_and_pending(self, mock_active, mock_pending):
        from dembrane.billing_service import count_net_new_seats

        mock_active.return_value = {"alice@x.com"}
        mock_pending.return_value = {"bob@x.com"}

        # alice=active, bob=pending, carol=new, duplicate carol counts once.
        n = await count_net_new_seats(
            "acc-1", ["alice@x.com", "bob@x.com", "carol@x.com", "carol@x.com"]
        )
        assert n == 1

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.account_pending_invite_emails", new_callable=AsyncMock)
    @patch("dembrane.billing_service.account_active_seat_emails", new_callable=AsyncMock)
    async def test_all_new(self, mock_active, mock_pending):
        from dembrane.billing_service import count_net_new_seats

        mock_active.return_value = set()
        mock_pending.return_value = set()
        assert await count_net_new_seats("acc-1", ["a@x.com", "b@x.com"]) == 2


class TestEstimateSeatAdditionNetNew:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_net_new_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_quote_matches_charge_for_net_new(
        self, mock_directus, mock_net_new, mock_fraction
    ):
        from dembrane.billing_service import estimate_seat_addition

        mock_directus.get_item = AsyncMock(return_value=_active_account())
        mock_net_new.return_value = 2
        mock_fraction.return_value = 1.0  # full period for an exact-match assert

        out = await estimate_seat_addition(
            "acc-1", recipient_emails=["a@x.com", "b@x.com"]
        )
        assert out["active"] is True
        assert out["added_seats"] == 2
        # changemaker annual: 75 * 12 * 2 = 1800.
        assert out["recurring_delta_eur"] == 1800.0
        assert out["prorated_now_eur"] == 1800.0

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_net_new_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_existing_only_quotes_zero(self, mock_directus, mock_net_new):
        from dembrane.billing_service import estimate_seat_addition

        mock_directus.get_item = AsyncMock(return_value=_active_account())
        mock_net_new.return_value = 0  # every recipient already seated

        out = await estimate_seat_addition("acc-1", recipient_emails=["alice@x.com"])
        # Active plan, but EUR0 net-new: "this user will cost nothing".
        assert out["active"] is True
        assert out["added_seats"] == 0
        assert out["prorated_now_eur"] == 0.0
        assert out["recurring_delta_eur"] == 0.0


# ── overview: Mollie-sourced amount + pending surfaced ───────────────────


class TestOverviewMollieSourced:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_pending_invites", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_next_invoice_uses_mollie_stored_amount(
        self, mock_mollie, mock_directus, mock_seats, mock_pending
    ):
        from dembrane.billing_service import get_billing_overview

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(return_value=_active_account())
        mock_seats.return_value = 2
        mock_pending.return_value = 0
        # Mollie still carries the OLD amount (e.g. re-price lagged). Display must
        # show Mollie's truth, not a live re-derivation.
        mock_mollie.get_subscription = AsyncMock(
            return_value={
                "amount": {"value": "900.00", "currency": "EUR"},
                "nextPaymentDate": "2026-07-01",
            }
        )
        mock_mollie.list_mandates = AsyncMock(return_value=[])

        out = await get_billing_overview("acc-1")
        assert out["next_invoice"]["amount"] == "900.00"
        assert out["next_invoice"]["currency"] == "EUR"
        assert out["reconcile_failed_at"] is None

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_pending_invites", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_surfaces_pending_and_projected_with_pending(
        self, mock_mollie, mock_directus, mock_seats, mock_pending
    ):
        from dembrane.billing_service import get_billing_overview

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value=_active_account(reconcile_failed_at="2026-06-17T00:00:00+00:00")
        )
        mock_seats.return_value = 2
        mock_pending.return_value = 3  # three un-accepted invites
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "1800.00", "currency": "EUR"}, "nextPaymentDate": "2026-07-01"}
        )
        mock_mollie.list_mandates = AsyncMock(return_value=[])

        out = await get_billing_overview("acc-1")
        assert out["pending_invites"] == 3
        # changemaker annual per-seat monthly = 75; (2 seats + 3 pending) * 75 = 375.
        assert out["projected_with_pending_eur"] == 375.0
        # Flag passes through for the "fix your payment" prompt.
        assert out["reconcile_failed_at"] == "2026-06-17T00:00:00+00:00"


# ── ISSUE-024·5: discount reaches the customer-facing displays ────────────


class TestOverviewDiscounted:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_pending_invites", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_projected_total_is_discounted(
        self, mock_mollie, mock_directus, mock_seats, mock_pending
    ):
        from dembrane.billing_service import get_billing_overview

        mock_mollie.MollieError = Exception
        mock_directus.get_item = AsyncMock(
            return_value=_active_account(percent_discount=10, type_discount="scholarship")
        )
        mock_seats.return_value = 2
        mock_pending.return_value = 3
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "1620.00", "currency": "EUR"}, "nextPaymentDate": "2026-07-01"}
        )
        mock_mollie.list_mandates = AsyncMock(return_value=[])

        out = await get_billing_overview("acc-1")
        # annual per-seat monthly = 75; 2 seats * 75 = 150; 10% off = 135.
        assert out["projected_monthly_eur"] == 135.0
        # (2 + 3 pending) * 75 = 375; 10% off = 337.5.
        assert out["projected_with_pending_eur"] == 337.5
        # Discount metadata surfaced for the "10% discount applied" label.
        assert out["percent_discount"] == 10
        assert out["type_discount"] == "scholarship"


class TestEstimateSeatAdditionDiscounted:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service._period_fraction_remaining", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_net_new_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_estimate_quote_is_discounted(
        self, mock_directus, mock_net_new, mock_fraction
    ):
        from dembrane.billing_service import estimate_seat_addition

        mock_directus.get_item = AsyncMock(return_value=_active_account(percent_discount=25))
        mock_net_new.return_value = 2
        mock_fraction.return_value = 1.0

        out = await estimate_seat_addition("acc-1", recipient_emails=["a@x.com", "b@x.com"])
        # 75*12*2 = 1800; 25% off = 1350.
        assert out["recurring_delta_eur"] == 1350.0
        assert out["prorated_now_eur"] == 1350.0


# ── Bug #4: account seats pool DISTINCT users across workspaces ───────────


class TestCountAccountSeatsDistinctUsers:
    @pytest.mark.asyncio
    @patch("dembrane.seat_capacity.effective_seat_user_ids", new_callable=AsyncMock)
    @patch("dembrane.billing_service._account_workspace_ids", new_callable=AsyncMock)
    async def test_user_in_two_workspaces_counts_once(self, mock_ws_ids, mock_seat_ids):
        from dembrane.billing_service import count_account_seats

        mock_ws_ids.return_value = ["ws-1", "ws-2"]
        # Alice is in both workspaces; Bob only in ws-1. Pooled distinct = 2.
        mock_seat_ids.side_effect = [{"alice", "bob"}, {"alice"}]

        assert await count_account_seats("acc-1") == 2

    @pytest.mark.asyncio
    @patch("dembrane.seat_capacity.effective_seat_user_ids", new_callable=AsyncMock)
    @patch("dembrane.billing_service._account_workspace_ids", new_callable=AsyncMock)
    async def test_existing_member_creating_workspace_is_zero_net_new(
        self, mock_ws_ids, mock_seat_ids
    ):
        """Bug #4: an existing seat-holder who creates (and owns) a new workspace
        adds no distinct user, so the account seat count is unchanged -> EUR0
        net-new, no phantom seat."""
        from dembrane.billing_service import count_account_seats

        # Before: one workspace, alice is the only seat.
        mock_ws_ids.return_value = ["ws-1"]
        mock_seat_ids.side_effect = [{"alice"}]
        before = await count_account_seats("acc-1")

        # After: alice created ws-2 and is its owner; she's already counted.
        mock_ws_ids.return_value = ["ws-1", "ws-2"]
        mock_seat_ids.side_effect = [{"alice"}, {"alice"}]
        after = await count_account_seats("acc-1")

        assert before == 1
        assert after == 1  # unchanged: no phantom +1 seat
