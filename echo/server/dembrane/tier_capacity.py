"""Per-tier capacity + pricing — the canonical matrix (ADR 0005).

Single source of truth for the tier × capability map. Every surface that shows
a tier's price, taglines, or limits reads from here — no duplication in i18n
strings, UI components, or email templates.

The model (ADR 0005, per-seat tiers):
    - Four tiers: free, innovator, changemaker, guardian.
    - Pricing is per seat / month, EUR, billed annually by default; monthly is
      +20%. `price_eur_monthly` is the per-seat annual-billing rate.
    - Hours are unlimited under fair use on every paid tier. Only Free keeps a
      cap (1 hour) — so the over-cap machinery (ADR 0001) is Free-only now.
    - Seats are metered and billed per seat; there is no "included bundle" or
      seat overage. Free is the one tier that hard-caps seats (single user).
    - Capability, not capacity, is what separates the paid tiers: BYO-LLM/MCP
      from Innovator, built-in analysis + audit logs + white labeling from
      Changemaker, the EU-sovereign stack at Guardian. Those gates live in
      `policies.py`; this file is price + the Free hour/seat cap.

When pricing changes, edit here. Downstream code reads these records and never
hard-codes the numbers.
"""

from __future__ import annotations

from typing import Optional
from dataclasses import dataclass

# Single source of truth for the monthly-billing premium. The per-seat price in
# `price_eur_monthly` is the annual-billing anchor; monthly cadence is the
# surcharged variant ("X% off when billed annually"). Editing this constant +
# a deploy is the entire workflow — no env var, no Directus row.
MONTHLY_BILLING_PREMIUM_PCT = 20


@dataclass(frozen=True)
class TierCapacity:
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]      # Per-seat annual-billing rate, EUR/seat/mo. None = Free.
    price_note: str                        # "free" / "per seat / month"
    included_seats: Optional[int]          # Hard seat cap. Free = 1; paid = None (unlimited, metered).
    seat_overage_eur: Optional[int]        # Always None — price is per seat, no overage concept.
    included_hours: Optional[int]          # Free = 1; paid = None (unlimited, fair use).
    hour_overage_eur: Optional[int]        # Always None — no hour overage.
    hard_block_on_hours: bool              # Deprecated: always False. Kept for call-site compat.
    training_included: str                 # human-readable
    duration: str                          # "ongoing" / etc
    # True when the tier supports annual + monthly cadences (all paid tiers).
    # False for Free (no price). The API serializer uses this to populate
    # `pricing.annual_billing` + `pricing.monthly_billing` vs leaving it null.
    billing_period_applicable: bool = False
    # Unused since Pilot's removal; kept so build_tier_pricing stays total.
    one_time_amount_eur: Optional[int] = None


@dataclass(frozen=True)
class UsageGates:
    """Workspace-level gate flags for over-cap UI gating (Free only)."""
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
    "innovator": TierCapacity(
        tier="innovator",
        tagline="Bring your own LLM",
        price_eur_monthly=20,
        price_note="per seat / month",
        included_seats=None,
        seat_overage_eur=None,
        included_hours=None,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
    "changemaker": TierCapacity(
        tier="changemaker",
        tagline="Built-in analysis, audit logs, white labeling",
        price_eur_monthly=75,
        price_note="per seat / month",
        included_seats=None,
        seat_overage_eur=None,
        included_hours=None,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
    "guardian": TierCapacity(
        tier="guardian",
        tagline="EU-sovereign, CLOUD Act safe",
        price_eur_monthly=150,
        price_note="per seat / month",
        included_seats=None,
        seat_overage_eur=None,
        included_hours=None,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        training_included="—",
        duration="ongoing",
        billing_period_applicable=True,
    ),
}


def compute_monthly_billing_price(annual_per_month: int) -> int:
    """Monthly-cadence per-seat price derived from the annual-billing rate.

    The annual rate is the anchor; monthly cadence is
    `annual × (1 + MONTHLY_BILLING_PREMIUM_PCT/100)`, rounded to whole euros.
    Pure function — same input, same output.
    """
    return round(annual_per_month * (1 + MONTHLY_BILLING_PREMIUM_PCT / 100))


def build_tier_pricing(tier: str) -> Optional[dict]:
    """Nested per-seat pricing dict for the public API.

    Returns None for Free (no price), else
    `{"annual_billing": {...}, "monthly_billing": {...}}` where the figures are
    per seat / month. The shape matches the `TierPricing` Pydantic model in
    `dembrane.api.v2.workspaces`; the math lives here so consumers can't drift.
    """
    cap = TIER_CAPACITIES.get(tier)
    if cap is None:
        return None

    if cap.billing_period_applicable and cap.price_eur_monthly is not None:
        annual_per_seat = cap.price_eur_monthly
        return {
            "annual_billing": {
                "per_month_eur": annual_per_seat,
                "total_per_year_eur": annual_per_seat * 12,
            },
            "monthly_billing": {
                "per_month_eur": compute_monthly_billing_price(annual_per_seat),
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


def compute_hour_overage_eur(_tier: str, _hours_used: float) -> float:
    """Hour overage no longer exists (unlimited hours under fair use). Always 0.
    Kept for call-site compatibility."""
    return 0.0


def compute_seat_overage_eur(_tier: str, _seats_used: int) -> float:
    """Seat overage no longer exists — seats are billed per seat, not as
    overage above an included bundle. Always 0. Kept for call-site
    compatibility; the per-seat bill is seats × price_eur_monthly."""
    return 0.0


def monthly_seat_bill_eur(tier: str, seats_used: int) -> float:
    """Per-seat monthly bill: seats × the tier's per-seat price. 0 for Free."""
    cap = get_capacity(tier)
    if cap is None or cap.price_eur_monthly is None:
        return 0.0
    return round(seats_used * cap.price_eur_monthly, 2)


def is_hard_blocked(_tier: str, _hours_used: float) -> bool:
    """Deprecated: always returns False. Recording never fails on any tier."""
    return False


# Paid tiers bill per seat and have unlimited hours — they never gate on hours.
# Free is the only tier that gates consumption (1-hour cap).
_OVERAGE_TIERS = frozenset({"innovator", "changemaker", "guardian"})


def tier_allows_overage(tier: str) -> bool:
    """True for paid tiers (unlimited hours, never gated). False for Free, which
    gates consumption via is_over_cap / uploads_locked at its 1-hour cap.

    Name kept for call-site compatibility; reads as "this tier is not
    hour-capped" under the per-seat model.
    """
    return tier in _OVERAGE_TIERS


def compute_is_over_cap(
    tier: str,
    workspace_audio_hours: float,
    conversation_duration_hours: float,
) -> bool:
    """Soft-edge stamp for a conversation finishing on a capped tier (Free only).

    Formula (ADR 0001): is_over_cap = NOT tier_allows_overage(tier)
        AND (workspace_audio_hours - conversation_duration_hours) >= included_hours

    Subtracting this conversation's own duration means a conversation that
    *started* under cap stays unlocked even if its recording crossed the cap.
    Paid tiers always return False (unlimited hours).
    """
    if tier_allows_overage(tier):
        return False
    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None:
        return False
    hours_before_this = workspace_audio_hours - conversation_duration_hours
    return hours_before_this >= cap.included_hours


def is_conversation_locked(conv: dict, tier: Optional[str]) -> bool:
    """Live lock: is_over_cap AND the current tier is hour-capped (Free)."""
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

    Only Free gates (1-hour cap): compare hours_lifetime >= included_hours.
    Paid tiers (unlimited hours) never gate.
    """
    if tier_allows_overage(tier):
        return UsageGates(over_cap_active=False, uploads_locked=False)

    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None:
        return UsageGates(over_cap_active=False, uploads_locked=False)

    at_or_over = hours_lifetime >= cap.included_hours
    return UsageGates(over_cap_active=at_or_over, uploads_locked=at_or_over)
