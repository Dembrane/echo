"""Integration test for GET /v2/workspaces/tier-capacities.

Asserts the per-seat nested `pricing` shape (ADR 0005): Free has no price,
paid tiers expose annual + monthly per-seat figures, no legacy top-level
`price_eur_monthly` / `price_note`.
"""

from __future__ import annotations

import pytest

from dembrane.api.v2.workspaces import list_tier_capacities


@pytest.mark.asyncio
async def test_tier_capacities_pricing_shape_per_kind():
    items = await list_tier_capacities()
    by_tier = {item.tier: item for item in items}

    # Free: pricing is None (no displayable price).
    free = by_tier["free"]
    assert free.pricing is None
    assert free.billing_period_applicable is False

    # Paid tiers: annual + monthly per-seat populated (+20% monthly).
    expected = {"innovator": 20, "changemaker": 75, "guardian": 150}
    for tier, annual in expected.items():
        item = by_tier[tier]
        assert item.billing_period_applicable is True
        assert item.pricing is not None
        assert item.pricing.annual_billing is not None
        assert item.pricing.annual_billing.per_month_eur == annual
        assert item.pricing.annual_billing.total_per_year_eur == annual * 12
        assert item.pricing.monthly_billing is not None
        assert item.pricing.monthly_billing.per_month_eur == round(annual * 1.20)


@pytest.mark.asyncio
async def test_tier_capacities_is_the_four_tiers():
    items = await list_tier_capacities()
    assert [i.tier for i in items] == ["free", "innovator", "changemaker", "guardian"]


@pytest.mark.asyncio
async def test_tier_capacities_legacy_fields_not_present():
    """`price_eur_monthly` and `price_note` were removed from the API."""
    items = await list_tier_capacities()
    assert items, "tier-capacities endpoint must not return an empty list"
    sample = items[0].model_dump()
    assert "price_eur_monthly" not in sample
    assert "price_note" not in sample
    assert "pricing" in sample
    assert "billing_period_applicable" in sample
