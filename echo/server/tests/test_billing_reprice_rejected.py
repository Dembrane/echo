"""A Mollie 422 on the subscription re-price (e.g. amount above the account's
per-method maximum) is deterministic for the same amount. The hourly reconcile
must remember the rejected amount and stop re-sending it (and stop logging an
error every hour) until the target amount changes."""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.mollie import MollieError


class _FakeRedis:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value if isinstance(value, bytes) else str(value).encode()

    async def delete(self, key):
        self.store.pop(key, None)


def _account(**overrides):
    base = {
        "id": "acc-1",
        "tier": "changemaker",
        "status": "active",
        "billing_period": "annual",
        "mollie_subscription_id": "sub_1",
        "mollie_customer_id": "cst_1",
        "provisioned_seats": 12,
        "reconcile_failed_at": None,
    }
    base.update(overrides)
    return base


class TestRepriceRejectedMemo:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.get_redis_client", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_same_amount_is_not_resent_after_422(
        self, mock_mollie, mock_directus, mock_seats, mock_redis
    ):
        from dembrane.billing_service import RepriceRejectedError, sync_subscription_seats

        fake = _FakeRedis()
        mock_redis.return_value = fake
        mock_mollie.MollieError = MollieError
        mock_directus.get_item = AsyncMock(return_value=_account())
        mock_seats.return_value = 12
        mock_mollie.get_subscription = AsyncMock(
            return_value={"amount": {"value": "900.00", "currency": "EUR"}}
        )
        mock_mollie.update_subscription_amount = AsyncMock(
            side_effect=MollieError(
                'Mollie PATCH /x -> 422: {"detail":"The amount is higher than the maximum"}',
                status_code=422,
            )
        )

        with pytest.raises(MollieError):
            await sync_subscription_seats("acc-1")
        assert mock_mollie.update_subscription_amount.await_count == 1

        # Second hourly run, same seats: no Mollie call, a distinguishable error.
        with pytest.raises(RepriceRejectedError) as exc:
            await sync_subscription_seats("acc-1")
        assert exc.value.repeated is True
        assert mock_mollie.update_subscription_amount.await_count == 1

        # Seats change -> target amount changes -> we try Mollie again.
        mock_seats.return_value = 2
        mock_mollie.update_subscription_amount = AsyncMock()
        assert await sync_subscription_seats("acc-1") == 1800.0
        assert fake.store == {}

    @pytest.mark.asyncio
    @patch("dembrane.billing_service.get_redis_client", new_callable=AsyncMock)
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    @patch("dembrane.billing_service.mollie")
    async def test_transient_5xx_is_not_memoized(
        self, mock_mollie, mock_directus, mock_seats, mock_redis
    ):
        from dembrane.billing_service import sync_subscription_seats

        fake = _FakeRedis()
        mock_redis.return_value = fake
        mock_mollie.MollieError = MollieError
        mock_directus.get_item = AsyncMock(return_value=_account())
        mock_seats.return_value = 12
        mock_mollie.get_subscription = AsyncMock(return_value={"amount": {"value": "0.00"}})
        mock_mollie.update_subscription_amount = AsyncMock(
            side_effect=MollieError("Mollie PATCH /x -> 503: down", status_code=503)
        )

        with pytest.raises(MollieError):
            await sync_subscription_seats("acc-1")
        with pytest.raises(MollieError):
            await sync_subscription_seats("acc-1")
        assert mock_mollie.update_subscription_amount.await_count == 2
        assert fake.store == {}


class TestReconcileLogsRepeatQuietly:
    @pytest.mark.asyncio
    @patch("dembrane.billing_service.count_account_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service._charge_seat_proration", new_callable=AsyncMock)
    @patch("dembrane.billing_service.sync_subscription_seats", new_callable=AsyncMock)
    @patch("dembrane.billing_service.async_directus")
    async def test_repeated_rejection_is_not_an_error_log(
        self, mock_directus, mock_sync, mock_charge, mock_seats, caplog
    ):
        from dembrane.billing_service import RepriceRejectedError, reconcile_account_seats

        mock_directus.get_item = AsyncMock(
            return_value=_account(reconcile_failed_at="2026-08-01T00:00:00+00:00")
        )
        mock_directus.update_item = AsyncMock()
        mock_sync.side_effect = RepriceRejectedError("still too high", repeated=True)
        mock_seats.return_value = 12

        with caplog.at_level(logging.INFO, logger="billing_service"):
            await reconcile_account_seats("acc-1")

        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        # Flag stays set (already flagged -> no write), nothing charged.
        mock_directus.update_item.assert_not_awaited()
        mock_charge.assert_not_awaited()
