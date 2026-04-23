"""Per-tier capacity + pricing — the canonical matrix.

Single source of truth for matrix v1.1 §1 (tier × capacity). Every surface
that shows a tier's limits, taglines, or pricing should read from here —
no duplication in i18n strings, UI components, or email templates.

Hard truths encoded here:
    - Pilot hard-blocks host-side operations at the hour cap.
    - Pioneer+ tiers bill overage; no hard block.
    - Guardian is unlimited, subject to commercial agreement.

When pricing changes, edit here. Downstream code reads these records and
never hard-codes the numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class TierCapacity:
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]      # None for one-off Pilot, None for Guardian
    price_note: str                        # "one-time" / "per month" / "negotiated"
    included_seats: Optional[int]          # None = unlimited
    seat_overage_eur: Optional[int]        # None = not billed
    included_hours: Optional[int]          # None = unlimited
    hour_overage_eur: Optional[int]        # None = hard block (pilot) or unlimited (guardian)
    hard_block_on_hours: bool              # Pilot only
    guest_cap: Optional[int]               # None = unlimited
    training_included: str                 # human-readable
    duration: str                          # "1 month" / "ongoing" / etc


# Ordered lowest → highest. Matches TIER_ORDER in policies.py.
TIER_CAPACITIES: dict[str, TierCapacity] = {
    "pilot": TierCapacity(
        tier="pilot",
        tagline="one month to try it.",
        price_eur_monthly=None,
        price_note="€349 one-time",
        included_seats=2,
        seat_overage_eur=None,
        included_hours=10,
        hour_overage_eur=None,
        hard_block_on_hours=True,
        guest_cap=2,
        training_included="2 people",
        duration="1 month",
    ),
    "pioneer": TierCapacity(
        tier="pioneer",
        tagline="for your first real engagements.",
        price_eur_monthly=200,
        price_note="per month",
        included_seats=3,
        seat_overage_eur=25,
        included_hours=25,
        hour_overage_eur=5,
        hard_block_on_hours=False,
        guest_cap=5,
        training_included="—",
        duration="ongoing",
    ),
    "innovator": TierCapacity(
        tier="innovator",
        tagline="privacy and data portability.",
        price_eur_monthly=500,
        price_note="per month",
        included_seats=10,
        seat_overage_eur=30,
        included_hours=50,
        hour_overage_eur=4,
        hard_block_on_hours=False,
        guest_cap=20,
        training_included="—",
        duration="ongoing",
    ),
    "changemaker": TierCapacity(
        tier="changemaker",
        tagline="your brand, your integrations.",
        price_eur_monthly=1500,
        price_note="per month",
        included_seats=20,
        seat_overage_eur=60,
        included_hours=100,
        hour_overage_eur=3,
        hard_block_on_hours=False,
        guest_cap=50,
        training_included="—",
        duration="ongoing",
    ),
    "guardian": TierCapacity(
        tier="guardian",
        tagline="enterprise scale.",
        price_eur_monthly=5000,
        price_note="per month",
        included_seats=None,
        seat_overage_eur=None,
        included_hours=None,
        hour_overage_eur=None,
        hard_block_on_hours=False,
        guest_cap=None,
        training_included="negotiable",
        duration="ongoing",
    ),
}


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
    """Monthly overage cost in € for a given tier + hours used. Zero when
    under the included cap, for Pilot (hard block — no overage bill), and
    for Guardian (unlimited)."""
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
