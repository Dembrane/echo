"""Tests for the staff Payments rollup (ISSUE-022 / Wave B).

Covers:
- Staff gate (403 for non-admin).
- Aggregation across billing accounts: pooled, newest-first ordering,
  per-status counters (paid sum / failed / open), account enrichment.
- Mollie-disabled environment returns the empty shell with the right flags
  and dashboard URL (test vs live), without calling Mollie.
- A single failing Mollie customer is skipped, not fatal.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2.admin import payments_rollup
from dembrane.api.dependency_auth import DirectusSession


def _auth(is_admin: bool = True) -> DirectusSession:
    return DirectusSession(user_id="staff-1", is_admin=is_admin)


def _settings(*, enabled: bool, test_mode: bool):
    billing = SimpleNamespace(mollie_enabled=enabled, mollie_test_mode=test_mode)
    return SimpleNamespace(billing=billing)


_ACCOUNTS = [
    {
        "id": "acc-1",
        "label": "Acme",
        "org_id": "org-1",
        "tier": "changemaker",
        "mollie_customer_id": "cst_1",
    },
    {
        "id": "acc-2",
        "label": "Globex",
        "org_id": "org-2",
        "tier": "innovator",
        "mollie_customer_id": "cst_2",
    },
]


def _directus_get_items(accounts):
    """Build an async get_items that serves accounts then org names."""

    async def _impl(collection, query):  # noqa: ARG001
        if collection == "billing_account":
            return accounts
        if collection == "org":
            return [
                {"id": "org-1", "name": "Acme Org"},
                {"id": "org-2", "name": "Globex Org"},
            ]
        return []

    return _impl


@pytest.mark.asyncio
async def test_non_admin_is_rejected():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await payments_rollup(_auth(is_admin=False))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.get_settings")
@patch("dembrane.api.v2.admin.async_directus")
async def test_mollie_disabled_returns_empty_shell(mock_directus, mock_get_settings):
    mock_get_settings.return_value = _settings(enabled=False, test_mode=False)
    mock_directus.get_items = AsyncMock(side_effect=_directus_get_items(_ACCOUNTS))

    with patch(
        "dembrane.api.v2.admin.mollie.list_customer_payments", new_callable=AsyncMock
    ) as mock_list:
        result = await payments_rollup(_auth())

    # No Mollie calls when disabled, but the accounts are still counted.
    mock_list.assert_not_called()
    assert result.mollie_enabled is False
    assert result.payment_count == 0
    assert result.accounts_with_customer == 2
    assert result.mollie_dashboard_url.endswith("/dashboard/payments")


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.get_settings")
@patch("dembrane.api.v2.admin.async_directus")
async def test_test_mode_dashboard_url(mock_directus, mock_get_settings):
    mock_get_settings.return_value = _settings(enabled=True, test_mode=True)
    mock_directus.get_items = AsyncMock(side_effect=_directus_get_items([]))

    with patch(
        "dembrane.api.v2.admin.mollie.list_customer_payments", new_callable=AsyncMock
    ):
        result = await payments_rollup(_auth())

    assert result.mollie_test_mode is True
    assert "org_test" in result.mollie_dashboard_url


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.get_settings")
@patch("dembrane.api.v2.admin.async_directus")
async def test_aggregates_and_counts_across_accounts(mock_directus, mock_get_settings):
    mock_get_settings.return_value = _settings(enabled=True, test_mode=False)
    mock_directus.get_items = AsyncMock(side_effect=_directus_get_items(_ACCOUNTS))

    payments_by_customer = {
        "cst_1": [
            {
                "id": "tr_old",
                "createdAt": "2026-01-01T10:00:00+00:00",
                "amount": {"value": "900.00", "currency": "EUR"},
                "status": "paid",
                "sequenceType": "first",
                "method": "creditcard",
                "description": "Changemaker plan",
                "_links": {"dashboard": {"href": "https://mollie/tr_old"}},
            },
            {
                "id": "tr_failed",
                "createdAt": "2026-02-01T10:00:00+00:00",
                "amount": {"value": "75.00", "currency": "EUR"},
                "status": "failed",
                "sequenceType": "recurring",
            },
        ],
        "cst_2": [
            {
                "id": "tr_newest",
                "createdAt": "2026-03-01T10:00:00+00:00",
                "amount": {"value": "100.00", "currency": "EUR"},
                "status": "paid",
                "sequenceType": "recurring",
            },
            {
                "id": "tr_open",
                "createdAt": "2026-02-15T10:00:00+00:00",
                "amount": {"value": "20.00", "currency": "EUR"},
                "status": "open",
                "sequenceType": "first",
            },
        ],
    }

    async def _list(customer_id, *, limit=50, from_id=None):  # noqa: ARG001
        return payments_by_customer.get(customer_id, [])

    with patch(
        "dembrane.api.v2.admin.mollie.list_customer_payments",
        new=AsyncMock(side_effect=_list),
    ):
        result = await payments_rollup(_auth())

    assert result.payment_count == 4
    # Newest-first pooled across both accounts (by createdAt, descending).
    assert [r.payment_id for r in result.rows] == [
        "tr_newest",  # 2026-03-01
        "tr_open",  # 2026-02-15
        "tr_failed",  # 2026-02-01
        "tr_old",  # 2026-01-01
    ]
    # paid sum is 900 + 100; failed and open counted separately.
    assert result.paid_eur == 1000.0
    assert result.failed_count == 1
    assert result.open_count == 1
    # Account + org enrichment flows through.
    first = next(r for r in result.rows if r.payment_id == "tr_old")
    assert first.account_label == "Acme"
    assert first.org_name == "Acme Org"
    assert first.tier == "changemaker"
    assert first.dashboard_url == "https://mollie/tr_old"


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.get_settings")
@patch("dembrane.api.v2.admin.async_directus")
async def test_one_failing_customer_is_skipped(mock_directus, mock_get_settings):
    from dembrane.mollie import MollieError

    mock_get_settings.return_value = _settings(enabled=True, test_mode=False)
    mock_directus.get_items = AsyncMock(side_effect=_directus_get_items(_ACCOUNTS))

    async def _list(customer_id, *, limit=50, from_id=None):  # noqa: ARG001
        if customer_id == "cst_1":
            raise MollieError("boom")
        return [
            {
                "id": "tr_ok",
                "createdAt": "2026-03-01T10:00:00+00:00",
                "amount": {"value": "100.00", "currency": "EUR"},
                "status": "paid",
                "sequenceType": "recurring",
            }
        ]

    with patch(
        "dembrane.api.v2.admin.mollie.list_customer_payments",
        new=AsyncMock(side_effect=_list),
    ):
        result = await payments_rollup(_auth())

    # cst_1 blew up but cst_2's payment still made it through.
    assert result.payment_count == 1
    assert result.rows[0].payment_id == "tr_ok"
    assert result.paid_eur == 100.0
