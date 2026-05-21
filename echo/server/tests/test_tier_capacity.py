"""Tests for dembrane.tier_capacity — tier matrix, helpers, and usage gates.

Covers:
    - Free tier exists in the matrix with correct capacity values.
    - TIER_CAPACITIES order matches TIER_ORDER in policies.py.
    - tier_allows_overage() returns correct values for each tier.
    - is_hard_blocked() always returns False (deprecated).
    - compute_usage_gates() exhaustive matrix: each tier × under/at/over cap.
    - compute_is_over_cap() soft-edge formula: each tier × under/at/over × started-under/started-over.
    - next_tier() includes free in the chain.
    - Unknown tier handling.
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
    compute_monthly_billing_price,
)

# ── Tier matrix structure ──


class TestTierMatrix:
    def test_free_exists_in_capacities(self):
        assert "free" in TIER_CAPACITIES

    def test_free_is_first_in_order(self):
        assert TIER_ORDER[0] == "free"
        assert list(TIER_CAPACITIES.keys())[0] == "free"

    def test_tier_order_matches_capacities_order(self):
        assert list(TIER_CAPACITIES.keys()) == TIER_ORDER

    def test_free_capacity_values(self):
        cap = get_capacity("free")
        assert cap is not None
        assert cap.tier == "free"
        assert cap.included_seats == 1
        assert cap.included_hours == 1
        assert cap.hour_overage_eur is None
        assert cap.seat_overage_eur is None
        assert cap.hard_block_on_hours is False

    def test_pilot_capacity_values(self):
        cap = get_capacity("pilot")
        assert cap is not None
        assert cap.included_seats == 2
        assert cap.included_hours == 10
        assert cap.hard_block_on_hours is False

    def test_all_tiers_have_hard_block_false(self):
        for tier_name, cap in TIER_CAPACITIES.items():
            assert cap.hard_block_on_hours is False, f"{tier_name} should not hard-block"

    def test_unknown_tier_returns_none(self):
        assert get_capacity("nonexistent") is None


# ── tier_allows_overage ──


class TestTierAllowsOverage:
    @pytest.mark.parametrize("tier", ["free", "pilot"])
    def test_no_overage_tiers(self, tier: str):
        assert tier_allows_overage(tier) is False

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tiers(self, tier: str):
        assert tier_allows_overage(tier) is True

    def test_unknown_tier_no_overage(self):
        assert tier_allows_overage("nonexistent") is False


# ── is_hard_blocked (deprecated) ──


class TestIsHardBlocked:
    @pytest.mark.parametrize("tier", TIER_ORDER)
    def test_never_blocks_any_tier(self, tier: str):
        assert is_hard_blocked(tier, 0.0) is False
        assert is_hard_blocked(tier, 999.0) is False

    def test_never_blocks_unknown_tier(self):
        assert is_hard_blocked("nonexistent", 999.0) is False


# ── compute_usage_gates ──


class TestComputeUsageGates:
    """Exhaustive matrix: each tier × under/at/over cap."""

    # Free: 1 hour lifetime cap
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
        assert gates.uploads_locked is True

    # Pilot: 10 hours lifetime cap
    def test_pilot_under_cap(self):
        gates = compute_usage_gates("pilot", hours_lifetime=5.0, _hours_this_month=5.0)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False

    def test_pilot_at_cap(self):
        gates = compute_usage_gates("pilot", hours_lifetime=10.0, _hours_this_month=3.0)
        assert gates.over_cap_active is True
        assert gates.uploads_locked is True

    def test_pilot_over_cap(self):
        gates = compute_usage_gates("pilot", hours_lifetime=15.0, _hours_this_month=2.0)
        assert gates.over_cap_active is True
        assert gates.uploads_locked is True

    # Pioneer+ (overage tiers): gates never fire
    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_under_cap(self, tier: str):
        gates = compute_usage_gates(tier, hours_lifetime=0.5, _hours_this_month=0.5)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_over_cap(self, tier: str):
        gates = compute_usage_gates(tier, hours_lifetime=999.0, _hours_this_month=999.0)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False

    def test_unknown_tier_gates_never_fire(self):
        gates = compute_usage_gates("nonexistent", hours_lifetime=999.0, _hours_this_month=999.0)
        assert gates.over_cap_active is False
        assert gates.uploads_locked is False


# ── next_tier ──


class TestNextTier:
    def test_free_next_is_pilot(self):
        assert next_tier("free") == "pilot"

    def test_pilot_next_is_pioneer(self):
        assert next_tier("pilot") == "pioneer"

    def test_guardian_has_no_next(self):
        assert next_tier("guardian") is None

    def test_unknown_has_no_next(self):
        assert next_tier("nonexistent") is None


# ── compute_is_over_cap (ADR 0001 soft-edge formula) ──


class TestComputeIsOverCap:
    """Exhaustive: tier × under/at/over cap × started-under/started-over.

    Formula: is_over_cap = NOT tier_allows_overage(tier)
        AND (workspace_audio_hours - conversation_duration_hours) >= included_hours

    Free cap = 1 hour, Pilot cap = 10 hours.
    """

    # ── Free tier (1 hour lifetime cap) ──

    def test_free_under_cap_started_under(self):
        """0.6h total after 0.3h recording → started at 0.3h, under 1h cap."""
        assert compute_is_over_cap("free", 0.6, 0.3) is False

    def test_free_at_cap_started_under(self):
        """1.0h total after 0.5h recording → started at 0.5h, under cap."""
        assert compute_is_over_cap("free", 1.0, 0.5) is False

    def test_free_crossed_cap_started_under(self):
        """1.1h total after 0.6h recording → started at 0.5h, under cap (soft edge)."""
        assert compute_is_over_cap("free", 1.1, 0.6) is False

    def test_free_over_cap_started_at_cap(self):
        """1.5h total after 0.5h recording → started at 1.0h, exactly at cap."""
        assert compute_is_over_cap("free", 1.5, 0.5) is True

    def test_free_over_cap_started_over(self):
        """1.5h total after 0.3h recording → started at 1.2h, over cap."""
        assert compute_is_over_cap("free", 1.5, 0.3) is True

    def test_free_way_over_cap(self):
        """5.0h total after 0.1h recording → started at 4.9h."""
        assert compute_is_over_cap("free", 5.0, 0.1) is True

    def test_free_exactly_at_boundary(self):
        """1.0h total after 0.0h recording → started at 1.0h, at cap boundary."""
        assert compute_is_over_cap("free", 1.0, 0.0) is True

    def test_free_zero_usage(self):
        """0.0h total, 0.0h recording → under cap."""
        assert compute_is_over_cap("free", 0.0, 0.0) is False

    # ── Pilot tier (10 hours lifetime cap) ──

    def test_pilot_under_cap_started_under(self):
        assert compute_is_over_cap("pilot", 5.0, 1.0) is False

    def test_pilot_at_cap_started_under(self):
        """10h total after 2h recording → started at 8h, under 10h cap."""
        assert compute_is_over_cap("pilot", 10.0, 2.0) is False

    def test_pilot_crossed_cap_started_under(self):
        """11h total after 3h recording → started at 8h, under cap (soft edge)."""
        assert compute_is_over_cap("pilot", 11.0, 3.0) is False

    def test_pilot_over_cap_started_at_cap(self):
        """10.5h total after 0.5h recording → started at 10.0h, exactly at cap."""
        assert compute_is_over_cap("pilot", 10.5, 0.5) is True

    def test_pilot_over_cap_started_over(self):
        """12.0h total after 0.5h recording → started at 11.5h, over cap."""
        assert compute_is_over_cap("pilot", 12.0, 0.5) is True

    # ── Pioneer+ (overage tiers) — never stamps True ──

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_under_cap(self, tier: str):
        assert compute_is_over_cap(tier, 0.5, 0.2) is False

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_massively_over_cap(self, tier: str):
        assert compute_is_over_cap(tier, 999.0, 1.0) is False

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_at_exact_cap(self, tier: str):
        cap = get_capacity(tier)
        hours = cap.included_hours if cap and cap.included_hours else 100
        assert compute_is_over_cap(tier, float(hours), 0.0) is False

    # ── Unknown tier ──

    def test_unknown_tier_never_stamps(self):
        assert compute_is_over_cap("nonexistent", 999.0, 1.0) is False

    # ── Acceptance criteria from issue ──

    def test_ac_free_0_6h_after_0_3h_stamps_false(self):
        """AC: free at 0.6h lifetime after 0.3h recording → started under cap."""
        assert compute_is_over_cap("free", 0.6, 0.3) is False

    def test_ac_free_1_5h_after_0_3h_stamps_true(self):
        """AC: free at 1.5h lifetime after 0.3h recording → started at 1.2h, over cap."""
        assert compute_is_over_cap("free", 1.5, 0.3) is True

    def test_ac_free_1_1h_after_0_6h_stamps_false(self):
        """AC: free at 1.1h lifetime after 0.6h recording → started at 0.5h, under cap."""
        assert compute_is_over_cap("free", 1.1, 0.6) is False

    def test_ac_pioneer_never_stamps_true(self):
        """AC: pioneer conversation never stamps true regardless of usage."""
        assert compute_is_over_cap("pioneer", 100.0, 1.0) is False


# ── Monthly billing premium math ──


class TestComputeMonthlyBillingPrice:
    def test_premium_is_ten_percent(self):
        assert MONTHLY_BILLING_PREMIUM_PCT == 10

    def test_pioneer_base(self):
        # 200 * 1.10 = 220
        assert compute_monthly_billing_price(200) == 220

    def test_innovator_base(self):
        # 500 * 1.10 = 550
        assert compute_monthly_billing_price(500) == 550

    def test_changemaker_base(self):
        # 1500 * 1.10 = 1650
        assert compute_monthly_billing_price(1500) == 1650

    def test_guardian_base(self):
        # 5000 * 1.10 = 5500
        assert compute_monthly_billing_price(5000) == 5500

    def test_odd_rate_rounds_to_nearest_euro(self):
        # 333 * 1.10 = 366.3 → 366
        assert compute_monthly_billing_price(333) == 366

    def test_zero_stays_zero(self):
        assert compute_monthly_billing_price(0) == 0


# ── Nested pricing builder ──


class TestBuildTierPricing:
    def test_free_returns_none(self):
        assert build_tier_pricing("free") is None

    def test_unknown_tier_returns_none(self):
        assert build_tier_pricing("nonexistent") is None

    def test_pilot_has_only_one_time(self):
        p = build_tier_pricing("pilot")
        assert p == {"one_time": {"amount_eur": 349}}
        assert "annual_billing" not in p
        assert "monthly_billing" not in p

    @pytest.mark.parametrize(
        ("tier", "annual"),
        [
            ("pioneer", 200),
            ("innovator", 500),
            ("changemaker", 1500),
            ("guardian", 5000),
        ],
    )
    def test_overage_tiers_have_annual_and_monthly(self, tier: str, annual: int):
        p = build_tier_pricing(tier)
        assert p is not None
        assert "one_time" not in p
        assert p["annual_billing"]["per_month_eur"] == annual
        assert p["annual_billing"]["total_per_year_eur"] == annual * 12
        assert p["monthly_billing"]["per_month_eur"] == round(annual * 1.10)

    def test_billing_period_applicable_flag(self):
        assert get_capacity("free").billing_period_applicable is False
        assert get_capacity("pilot").billing_period_applicable is False
        for tier in ("pioneer", "innovator", "changemaker", "guardian"):
            assert get_capacity(tier).billing_period_applicable is True
