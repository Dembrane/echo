"""Tests for dembrane.tier_capacity — the new per-seat tier matrix (ADR 0005).

Covers:
    - Four tiers: free, innovator, changemaker, guardian.
    - Free is the only hour-capped tier; paid tiers are unlimited.
    - tier_allows_overage(): paid tiers True (never gated), free False.
    - per-seat pricing (EUR), +20% monthly premium, monthly_seat_bill_eur.
    - compute_usage_gates / compute_is_over_cap: Free-only gating.
    - next_tier() chain; unknown tier handling.
"""

from __future__ import annotations

import pytest

from dembrane.policies import TIER_ORDER
from dembrane.tier_capacity import (
    TIER_CAPACITIES,
    MONTHLY_BILLING_PREMIUM_PCT,
    next_tier,
    get_capacity,
    is_hard_blocked,
    build_tier_pricing,
    compute_is_over_cap,
    compute_usage_gates,
    tier_allows_overage,
    monthly_seat_bill_eur,
    compute_monthly_billing_price,
)

PAID_TIERS = ["innovator", "changemaker", "guardian"]


# ── Tier matrix structure ──


class TestTierMatrix:
    def test_tiers_are_the_four(self):
        assert list(TIER_CAPACITIES.keys()) == ["free", "innovator", "changemaker", "guardian"]

    def test_tier_order_matches_capacities_order(self):
        assert list(TIER_CAPACITIES.keys()) == TIER_ORDER

    def test_pilot_and_pioneer_are_gone(self):
        assert "pilot" not in TIER_CAPACITIES
        assert "pioneer" not in TIER_CAPACITIES

    def test_free_capacity_values(self):
        cap = get_capacity("free")
        assert cap is not None
        assert cap.included_seats == 1
        assert cap.included_hours == 1
        assert cap.price_eur_monthly is None
        assert cap.billing_period_applicable is False

    @pytest.mark.parametrize(("tier", "price"), [("innovator", 20), ("changemaker", 75), ("guardian", 150)])
    def test_paid_tier_values(self, tier: str, price: int):
        cap = get_capacity(tier)
        assert cap is not None
        assert cap.price_eur_monthly == price          # per seat / month
        assert cap.included_seats is None              # unlimited, metered
        assert cap.included_hours is None              # unlimited hours
        assert cap.billing_period_applicable is True

    def test_all_tiers_have_hard_block_false(self):
        for tier_name, cap in TIER_CAPACITIES.items():
            assert cap.hard_block_on_hours is False, f"{tier_name} should not hard-block"

    def test_unknown_tier_returns_none(self):
        assert get_capacity("nonexistent") is None


# ── tier_allows_overage (i.e. "not hour-capped") ──


class TestTierAllowsOverage:
    def test_free_is_capped(self):
        assert tier_allows_overage("free") is False

    @pytest.mark.parametrize("tier", PAID_TIERS)
    def test_paid_tiers_uncapped(self, tier: str):
        assert tier_allows_overage(tier) is True

    def test_unknown_tier_no_overage(self):
        assert tier_allows_overage("nonexistent") is False


# ── is_hard_blocked (deprecated) ──


class TestIsHardBlocked:
    @pytest.mark.parametrize("tier", TIER_ORDER)
    def test_never_blocks_any_tier(self, tier: str):
        assert is_hard_blocked(tier, 0.0) is False
        assert is_hard_blocked(tier, 999.0) is False


# ── compute_usage_gates (Free-only) ──


class TestComputeUsageGates:
    def test_free_under_cap(self):
        gates = compute_usage_gates("free", hours_lifetime=0.5, _hours_this_month=0.5)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False

    def test_free_at_cap(self):
        gates = compute_usage_gates("free", hours_lifetime=1.0, _hours_this_month=1.0)
        assert gates.over_cap_active is True
        assert gates.uploads_locked is True

    def test_free_over_cap(self):
        gates = compute_usage_gates("free", hours_lifetime=2.5, _hours_this_month=0.3)
        assert gates.over_cap_active is True

    @pytest.mark.parametrize("tier", PAID_TIERS)
    def test_paid_tier_never_gates(self, tier: str):
        gates = compute_usage_gates(tier, hours_lifetime=999.0, _hours_this_month=999.0)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False

    def test_unknown_tier_never_gates(self):
        gates = compute_usage_gates("nonexistent", hours_lifetime=999.0, _hours_this_month=999.0)
        assert gates.over_cap_active is False


# ── next_tier ──


class TestNextTier:
    def test_free_next_is_innovator(self):
        assert next_tier("free") == "innovator"

    def test_innovator_next_is_changemaker(self):
        assert next_tier("innovator") == "changemaker"

    def test_changemaker_next_is_guardian(self):
        assert next_tier("changemaker") == "guardian"

    def test_guardian_has_no_next(self):
        assert next_tier("guardian") is None

    def test_unknown_has_no_next(self):
        assert next_tier("nonexistent") is None


# ── compute_is_over_cap (Free-only, ADR 0001 soft edge) ──


class TestComputeIsOverCap:
    def test_free_started_under_stays_false(self):
        # 1.1h total after 0.6h recording → started at 0.5h, under 1h cap
        assert compute_is_over_cap("free", 1.1, 0.6) is False

    def test_free_started_at_cap_stamps_true(self):
        # 1.5h total after 0.5h recording → started at 1.0h, at cap
        assert compute_is_over_cap("free", 1.5, 0.5) is True

    def test_free_started_over_stamps_true(self):
        assert compute_is_over_cap("free", 1.5, 0.3) is True

    def test_free_zero_usage(self):
        assert compute_is_over_cap("free", 0.0, 0.0) is False

    @pytest.mark.parametrize("tier", PAID_TIERS)
    def test_paid_tier_never_stamps(self, tier: str):
        assert compute_is_over_cap(tier, 999.0, 1.0) is False

    def test_unknown_tier_never_stamps(self):
        assert compute_is_over_cap("nonexistent", 999.0, 1.0) is False


# ── Monthly billing premium math (+20%) ──


class TestComputeMonthlyBillingPrice:
    def test_premium_is_twenty_percent(self):
        assert MONTHLY_BILLING_PREMIUM_PCT == 20

    @pytest.mark.parametrize(("annual", "monthly"), [(20, 24), (75, 90), (150, 180)])
    def test_per_seat_monthly(self, annual: int, monthly: int):
        assert compute_monthly_billing_price(annual) == monthly

    def test_odd_rate_rounds_to_nearest_euro(self):
        # 33 * 1.20 = 39.6 → 40
        assert compute_monthly_billing_price(33) == 40

    def test_zero_stays_zero(self):
        assert compute_monthly_billing_price(0) == 0


# ── Per-seat monthly bill ──


class TestMonthlySeatBill:
    def test_free_is_zero(self):
        assert monthly_seat_bill_eur("free", 5) == 0.0

    @pytest.mark.parametrize(
        ("tier", "seats", "bill"),
        [("innovator", 3, 60), ("changemaker", 4, 300), ("guardian", 2, 300)],
    )
    def test_seats_times_price(self, tier: str, seats: int, bill: float):
        assert monthly_seat_bill_eur(tier, seats) == bill

    def test_unknown_tier_zero(self):
        assert monthly_seat_bill_eur("nonexistent", 5) == 0.0


# ── Nested pricing builder (per seat) ──


class TestBuildTierPricing:
    def test_free_returns_none(self):
        assert build_tier_pricing("free") is None

    def test_unknown_tier_returns_none(self):
        assert build_tier_pricing("nonexistent") is None

    @pytest.mark.parametrize(("tier", "annual"), [("innovator", 20), ("changemaker", 75), ("guardian", 150)])
    def test_paid_tiers_have_annual_and_monthly(self, tier: str, annual: int):
        p = build_tier_pricing(tier)
        assert p is not None
        assert "one_time" not in p
        assert p["annual_billing"]["per_month_eur"] == annual
        assert p["annual_billing"]["total_per_year_eur"] == annual * 12
        assert p["monthly_billing"]["per_month_eur"] == round(annual * 1.20)

    def test_billing_period_applicable_flag(self):
        assert get_capacity("free").billing_period_applicable is False
        for tier in PAID_TIERS:
            assert get_capacity(tier).billing_period_applicable is True
