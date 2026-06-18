"""Admin billing-rollup discount coverage (ISSUE-024 sub-item 5).

A staff-set percent_discount must reduce the admin per-account forecast and the
MRR headline, mirroring the real Mollie charge (displayed == charged). Trials /
comped accounts already net to 0 and stay there. Directus + per-workspace helpers
are mocked so the test exercises the rollup arithmetic, not the data layer.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.dependency_auth import DirectusSession


def _admin_session() -> DirectusSession:
    return DirectusSession(user_id="staff-1", is_admin=True)


def _patch_rollup_helpers(workspaces: list[dict]):
    """Patch the I/O helpers billing_rollup fans out to, leaving the pricing +
    discount arithmetic live."""
    return [
        patch(
            "dembrane.api.v2.admin._all_active_workspaces",
            new=AsyncMock(return_value=workspaces),
        ),
        patch(
            "dembrane.api.v2.admin._org_name_map",
            new=AsyncMock(return_value={"org-1": "Org One"}),
        ),
        patch(
            "dembrane.api.v2.admin._workspace_hours_this_cycle",
            new=AsyncMock(return_value=0.0),
        ),
        patch(
            "dembrane.api.v2.admin.compute_effective_seat_state",
            new=AsyncMock(return_value=(2, 2, 0)),
        ),
        patch(
            "dembrane.api.v2.admin._workspace_admins",
            new=AsyncMock(return_value=[]),
        ),
        patch(
            "dembrane.api.v2.admin._recent_login_count",
            new=AsyncMock(return_value=0),
        ),
    ]


@pytest.mark.asyncio
async def test_discount_reduces_forecast_and_mrr():
    from dembrane.api.v2.admin import billing_rollup

    workspaces = [
        {
            "id": "ws-1",
            "name": "Discounted",
            "org_id": "org-1",
            "tier": "changemaker",  # base 1500
            "percent_discount": 40,
        },
    ]
    patchers = _patch_rollup_helpers(workspaces)
    for p in patchers:
        p.start()
    try:
        resp = await billing_rollup(_admin_session(), month_offset=0)
    finally:
        for p in patchers:
            p.stop()

    row = resp.rows[0]
    # Sticker base 1500, discounted 40% -> 900. No overage in the per-seat model.
    assert row.base_price_eur == 1500.0
    assert row.total_forecast_eur == 900.0
    assert row.percent_discount == 40
    # Headline forecast sums the discounted row totals.
    assert resp.total_forecast_eur == 900.0
    # MRR is the discounted recurring base.
    assert resp.mrr_eur == 900.0


@pytest.mark.asyncio
async def test_no_discount_is_full_price():
    from dembrane.api.v2.admin import billing_rollup

    workspaces = [
        {
            "id": "ws-1",
            "name": "Full price",
            "org_id": "org-1",
            "tier": "changemaker",
            "percent_discount": None,
        },
    ]
    patchers = _patch_rollup_helpers(workspaces)
    for p in patchers:
        p.start()
    try:
        resp = await billing_rollup(_admin_session(), month_offset=0)
    finally:
        for p in patchers:
            p.stop()

    assert resp.rows[0].total_forecast_eur == 1500.0
    assert resp.mrr_eur == 1500.0


@pytest.mark.asyncio
async def test_full_discount_floors_to_zero():
    from dembrane.api.v2.admin import billing_rollup

    workspaces = [
        {
            "id": "ws-1",
            "name": "Comped",
            "org_id": "org-1",
            "tier": "changemaker",
            "percent_discount": 100,  # comped / trial-equivalent
        },
    ]
    patchers = _patch_rollup_helpers(workspaces)
    for p in patchers:
        p.start()
    try:
        resp = await billing_rollup(_admin_session(), month_offset=0)
    finally:
        for p in patchers:
            p.stop()

    assert resp.rows[0].total_forecast_eur == 0.0
    assert resp.mrr_eur == 0.0
