"""Integration test for GET /v2/workspaces/tier-capacities.

Snapshots one tier of each kind (free, pilot, pioneer, guardian) and asserts
the new nested `pricing` shape — no `price_eur_monthly` / `price_note` top-
level fields. Slice 01 of the billing-period toggle work.
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

    # Pilot: only `one_time` populated.
    pilot = by_tier["pilot"]
    assert pilot.billing_period_applicable is False
    assert pilot.pricing is not None
    assert pilot.pricing.one_time is not None
    assert pilot.pricing.one_time.amount_eur == 349
    assert pilot.pricing.annual_billing is None
    assert pilot.pricing.monthly_billing is None

    # Pioneer: annual + monthly populated, no one_time.
    pioneer = by_tier["pioneer"]
    assert pioneer.billing_period_applicable is True
    assert pioneer.pricing is not None
    assert pioneer.pricing.annual_billing is not None
    assert pioneer.pricing.annual_billing.per_month_eur == 200
    assert pioneer.pricing.annual_billing.total_per_year_eur == 2400
    assert pioneer.pricing.monthly_billing is not None
    assert pioneer.pricing.monthly_billing.per_month_eur == 220
    assert pioneer.pricing.one_time is None

    # Guardian: matrix anchors at €5000/mo, monthly cadence at €5500.
    guardian = by_tier["guardian"]
    assert guardian.billing_period_applicable is True
    assert guardian.pricing is not None
    assert guardian.pricing.annual_billing is not None
    assert guardian.pricing.annual_billing.per_month_eur == 5000
    assert guardian.pricing.annual_billing.total_per_year_eur == 60000
    assert guardian.pricing.monthly_billing is not None
    assert guardian.pricing.monthly_billing.per_month_eur == 5500


@pytest.mark.asyncio
async def test_tier_capacities_legacy_fields_not_present():
    """`price_eur_monthly` and `price_note` were removed from the API."""
    items = await list_tier_capacities()
    assert items, "tier-capacities endpoint must not return an empty list"
    sample = items[0].model_dump()
    assert "price_eur_monthly" not in sample
    assert "price_note" not in sample
    # New keys are present.
    assert "pricing" in sample
    assert "billing_period_applicable" in sample
