"""Per-tier capacity + pricing — the canonical matrix.

Single source of truth for matrix v1.1 §1 (tier × capacity). Every surface
that shows a tier's limits, taglines, or pricing should read from here —
no duplication in i18n strings, UI components, or email templates.

Hard truths encoded here:
    - Free + pilot have lifetime caps; no overage billing.
    - Pioneer+ tiers bill overage; no hard block.
    - Guardian is unlimited, subject to commercial agreement.

When pricing changes, edit here. Downstream code reads these records and
never hard-codes the numbers.
"""

from __future__ import annotations

from typing import Optional
from dataclasses import dataclass

# Single source of truth for the monthly-billing premium. The annual-billing
# price stored in `price_eur_monthly` is anchored as the regular price; the
# monthly cadence is the surcharged variant (matches standard SaaS framing
# of "X% off when billed annually"). Editing this constant + a deploy is the
# entire workflow for adjusting the premium — no env var, no Directus row.
MONTHLY_BILLING_PREMIUM_PCT = 10


@dataclass(frozen=True)
class TierCapacity:
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]      # Annual-billing per-month rate. None for one-off Pilot + Free.
    price_note: str                        # "one-time" / "per month" / "negotiated"
    included_seats: Optional[int]          # None = unlimited; guests share this pool
    seat_overage_eur: Optional[int]        # None = not billed
    included_hours: Optional[int]          # None = unlimited
    hour_overage_eur: Optional[int]        # None = no overage (free/pilot) or unlimited (guardian)
    hard_block_on_hours: bool              # Deprecated: always False. Kept for call-site compat.
    training_included: str                 # human-readable
    duration: str                          # "1 month" / "ongoing" / etc
    # True when the tier supports annual + monthly cadences (pioneer+).
    # False for free (no price) and pilot (one-time fee). The API serializer
    # uses this to populate `pricing.annual_billing` + `pricing.monthly_billing`
    # vs `pricing.one_time` vs leaving `pricing` null.
    billing_period_applicable: bool = False
    # One-time fee for tiers that aren't subscription-billed (currently pilot).
    # `build_tier_pricing` reads this so the constant has one home.
    one_time_amount_eur: Optional[int] = None


@dataclass(frozen=True)
class UsageGates:
    """Workspace-level gate flags for over-cap UI gating."""
    over_cap_active: bool
    uploads_locked: bool


# Ordered lowest → highest. Matches TIER_ORDER in policies.py.
TIER_CAPACITIES: dict[str, TierCapacity] = {
    "free": TierCapacity(
        tier="free",
        tagline="get started.",
        price_eur_monthly=None,
        price_note="free",
        included_seats=1,
        seat_overage_eur=None,
        included_hours=1,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="—",
        duration="—",
    ),
    "pilot": TierCapacity(
        tier="pilot",
        tagline="one month to try it.",
        price_eur_monthly=None,
        price_note="€349 one-time",
        included_seats=2,
        seat_overage_eur=None,
        included_hours=10,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="2 people",
        duration="1 month",
        one_time_amount_eur=349,
    ),
    "pioneer": TierCapacity(
        tier="pioneer",
        tagline="For small teams and single projects",
        price_eur_monthly=200,
        price_note="per month",
        included_seats=3,
        seat_overage_eur=25,
        included_hours=25,
        hour_overage_eur=5,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
    "innovator": TierCapacity(
        tier="innovator",
        tagline="For organisations with ongoing participation",
        price_eur_monthly=500,
        price_note="per month",
        included_seats=10,
        seat_overage_eur=30,
        included_hours=50,
        hour_overage_eur=4,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
    "changemaker": TierCapacity(
        tier="changemaker",
        tagline="For governments and enterprises",
        price_eur_monthly=1500,
        price_note="per month",
        included_seats=20,
        seat_overage_eur=60,
        included_hours=100,
        hour_overage_eur=3,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
    "guardian": TierCapacity(
        tier="guardian",
        tagline="For highest-compliance environments",
        price_eur_monthly=5000,
        price_note="per month",
        included_seats=None,
        seat_overage_eur=None,
        included_hours=None,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="negotiable",
        duration="ongoing",
        billing_period_applicable=True,
    ),
}


def compute_monthly_billing_price(annual_per_month: int) -> int:
    """Monthly-cadence per-month price derived from the annual-billing rate.

    The annual rate is treated as the anchor (regular price); the monthly
    cadence is `annual × (1 + MONTHLY_BILLING_PREMIUM_PCT/100)`, rounded to
    whole euros. Pure function — same input, same output.
    """
    return round(annual_per_month * (1 + MONTHLY_BILLING_PREMIUM_PCT / 100))


def build_tier_pricing(tier: str) -> Optional[dict]:
    """Nested pricing dict for the public API.

    Returns one of:
        - None for free (no price to display)
        - {"one_time": {"amount_eur": <pilot fee>}} for tiers with a one-time fee
        - {"annual_billing": {...}, "monthly_billing": {...}} for pioneer+

    The shape matches the `TierPricing` Pydantic model in
    `dembrane.api.v2.workspaces`; the function lives here so the math has
    one home and downstream consumers cannot drift.
    """
    cap = TIER_CAPACITIES.get(tier)
    if cap is None:
        return None

    if cap.one_time_amount_eur is not None:
        return {"one_time": {"amount_eur": cap.one_time_amount_eur}}

    if cap.billing_period_applicable and cap.price_eur_monthly is not None:
        annual_per_month = cap.price_eur_monthly
        return {
            "annual_billing": {
                "per_month_eur": annual_per_month,
                "total_per_year_eur": annual_per_month * 12,
            },
            "monthly_billing": {
                "per_month_eur": compute_monthly_billing_price(annual_per_month),
            },
        }

    return None


def get_capacity(tier: str) -> Optional[TierCapacity]:
    """Look up a tier's capacity. Returns None if the tier name is unknown
    (e.g., a legacy row). Callers should treat None as "unlimited / no
    block" rather than crashing."""
    return TIER_CAPACITIES.get(tier)


def next_tier(tier: str) -> Optional[str]:
    """Return the next tier up, or None if `tier` is the top (guardian) or
    unknown."""
    order = list(TIER_CAPACITIES.keys())
    try:
        idx = order.index(tier)
    except ValueError:
        return None
    if idx + 1 >= len(order):
        return None
    return order[idx + 1]


def compute_hour_overage_eur(tier: str, hours_used: float) -> float:
    """Monthly overage cost in EUR. Zero when under cap, for free/pilot
    (no overage billing), and for Guardian (unlimited)."""
    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None or cap.hour_overage_eur is None:
        return 0.0
    over = max(0.0, hours_used - cap.included_hours)
    return round(over * cap.hour_overage_eur, 2)


def compute_seat_overage_eur(tier: str, seats_used: int) -> float:
    """Monthly overage cost in € for exceeding the included seat count."""
    cap = get_capacity(tier)
    if cap is None or cap.included_seats is None or cap.seat_overage_eur is None:
        return 0.0
    over = max(0, seats_used - cap.included_seats)
    return round(over * cap.seat_overage_eur, 2)


def is_hard_blocked(_tier: str, _hours_used: float) -> bool:
    """Deprecated: always returns False.

    Recording never fails on any tier. Free + pilot gate UI instead of
    blocking host operations. Kept for call-site compatibility.
    """
    return False


_OVERAGE_TIERS = frozenset({"pioneer", "innovator", "changemaker", "guardian"})


def tier_allows_overage(tier: str) -> bool:
    """Does this tier bill overage instead of gating?

    Pioneer+ allow overage (monthly billing). Free + pilot do not — they
    gate consumption via is_over_cap / uploads_locked when the lifetime
    cap is reached.
    """
    return tier in _OVERAGE_TIERS


def compute_is_over_cap(
    tier: str,
    workspace_audio_hours: float,
    conversation_duration_hours: float,
) -> bool:
    """Soft-edge stamp for a conversation finishing on a non-overage tier.

    Formula (ADR 0001): is_over_cap = NOT tier_allows_overage(tier)
        AND (workspace_audio_hours - conversation_duration_hours) >= included_hours

    Subtracting this conversation's own duration means a conversation that
    *started* under cap stays unlocked even if its recording crossed the cap.
    Pioneer+ conversations always return False (overage is billed, not gated).
    """
    if tier_allows_overage(tier):
        return False
    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None:
        return False
    hours_before_this = workspace_audio_hours - conversation_duration_hours
    return hours_before_this >= cap.included_hours


def is_conversation_locked(conv: dict, tier: Optional[str]) -> bool:
    """Live lock: is_over_cap AND the current tier does not allow overage."""
    if not conv.get("is_over_cap"):
        return False
    if tier is None:
        return False
    return not tier_allows_overage(tier)


def compute_usage_gates(
    tier: str,
    hours_lifetime: float,
    _hours_this_month: float,
) -> UsageGates:
    """Workspace-level gate flags for over-cap UI gating.

    Two cap regimes:
    - Free + pilot (lifetime cap): compare hours_lifetime >= included_hours.
    - Pioneer+ (monthly cap, overage billed): gates never fire.
    """
    if tier_allows_overage(tier):
        return UsageGates(over_cap_active=False, uploads_locked=False)

    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None:
        return UsageGates(over_cap_active=False, uploads_locked=False)

    at_or_over = hours_lifetime >= cap.included_hours
    return UsageGates(over_cap_active=at_or_over, uploads_locked=at_or_over)
