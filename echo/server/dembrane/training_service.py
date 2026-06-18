"""Training service — catalog, per-user training status, license provisioning.

Training is its own dembrane product (ISSUE-020), separate from billing tiers.
No paid plan includes a training; sessions are requested and staff-provisioned.

A user is "trained" when they hold a `training_license` row with
`status = active` and `expires_at > now`. The license row IS the high-risk
verification record (one year). This module is the single source of truth for:

    - CATALOG        : the purchasable training products + pricing.
    - get_user_training_status   : one user's trained / not-trained state.
    - get_org_roster_training_map : org-wide map for the admin roster view.
    - provision_license          : write a license (computes expires_at).

All Directus access goes through async_directus. Money is EUR.
"""

from __future__ import annotations

from typing import Optional
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

# A certified training grants a one-year high-risk license.
LICENSE_DURATION_DAYS = 365
# Within this window of expiry, the license reads as "expiring soon" so the
# Inbox nudge can resurface before the user lapses.
EXPIRING_SOON_DAYS = 30


@dataclass(frozen=True)
class TrainingProduct:
    """One catalog entry. `coming_soon` products cannot be requested yet."""

    type: str  # online / in_person / flex
    name: str
    price_eur: int
    included_participants: int
    extra_price_eur: Optional[int]  # per extra participant; None when n/a
    level: str
    format: str
    grants_license: bool
    coming_soon: bool = False


# The catalog (dembrane.com/platform/use-cases). Founder-locked 2026-06-18:
# Online and In-person are certified (grant the one-year license). Flex is
# self-paced and coming soon. The Pilot is OUT of v1 and not modeled here.
CATALOG: list[TrainingProduct] = [
    TrainingProduct(
        type="online",
        name="Online",
        price_eur=675,
        included_participants=5,
        extra_price_eur=60,
        level="Foundational, 2h",
        format="Remote",
        grants_license=True,
    ),
    TrainingProduct(
        type="in_person",
        name="In person",
        price_eur=2500,
        included_participants=10,
        extra_price_eur=195,
        level="Advanced, 4h",
        format="On-site",
        grants_license=True,
    ),
    TrainingProduct(
        type="flex",
        name="Flex",
        price_eur=50,
        included_participants=1,
        extra_price_eur=None,
        level="Self-paced",
        format="Course",
        grants_license=True,
        coming_soon=True,
    ),
]

_CATALOG_BY_TYPE = {p.type: p for p in CATALOG}


def get_product(training_type: str) -> Optional[TrainingProduct]:
    """Look up a catalog product by type, or None for an unknown type."""
    return _CATALOG_BY_TYPE.get(training_type)


def is_requestable(training_type: str) -> bool:
    """True when a customer can request this product today (not coming soon)."""
    product = _CATALOG_BY_TYPE.get(training_type)
    return product is not None and not product.coming_soon


def compute_expires_at(completed_at: datetime) -> datetime:
    """A license expires LICENSE_DURATION_DAYS after completion."""
    return completed_at + timedelta(days=LICENSE_DURATION_DAYS)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _license_is_active(row: dict, now: datetime) -> bool:
    """A license counts as trained when status=active and expiry is in the
    future. A stored status of expired/revoked never counts, and an active
    row past its expiry is treated as not-trained (lazy expiry)."""
    if (row.get("status") or "active") != "active":
        return False
    expires = _parse_iso(row.get("expires_at"))
    if expires is None:
        return False
    return expires > now


def _status_from_license(row: Optional[dict], now: datetime) -> dict:
    """Build the per-user training-status payload from the best license row."""
    if row is None:
        return {"trained": False, "trained_until": None, "expiring_soon": False}
    expires = _parse_iso(row.get("expires_at"))
    trained = _license_is_active(row, now)
    expiring_soon = bool(
        trained and expires is not None and expires <= now + timedelta(days=EXPIRING_SOON_DAYS)
    )
    return {
        "trained": trained,
        "trained_until": row.get("expires_at") if trained else None,
        "expiring_soon": expiring_soon,
    }


async def get_user_training_status(app_user_id: str, org_id: Optional[str] = None) -> dict:
    """Return this user's training status: trained / not-trained + trained_until.

    Picks the license with the furthest-out expiry so a renewed user shows the
    longest active window. Scoped to `org_id` when provided (the license is the
    org's compliance record); otherwise considers all of the user's licenses.
    """
    now = datetime.now(timezone.utc)
    filter_: dict = {"app_user_id": {"_eq": app_user_id}}
    if org_id:
        filter_["org_id"] = {"_eq": org_id}

    rows = await async_directus.get_items(
        "training_license",
        {
            "query": {
                "filter": filter_,
                "fields": ["id", "status", "completed_at", "expires_at", "org_id"],
                "sort": ["-expires_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return _status_from_license(None, now)

    # Prefer an active row; fall back to the most-recent (already sorted) for
    # the trained_until=None / expired display.
    best_active = next((r for r in rows if _license_is_active(r, now)), None)
    return _status_from_license(best_active or rows[0], now)


async def get_org_roster_training_map(org_id: str, app_user_ids: list[str]) -> dict[str, dict]:
    """Map app_user_id -> training-status payload for a roster of org users.

    One batched query over the org's licenses keeps the roster view to a single
    round trip regardless of member count. Users with no license map to
    not-trained.
    """
    now = datetime.now(timezone.utc)
    result: dict[str, dict] = {uid: _status_from_license(None, now) for uid in app_user_ids}
    if not app_user_ids:
        return result

    rows = await async_directus.get_items(
        "training_license",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "app_user_id": {"_in": app_user_ids},
                },
                "fields": ["id", "app_user_id", "status", "completed_at", "expires_at"],
                "sort": ["-expires_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return result

    # Rows are sorted by -expires_at, so the first row seen per user is the
    # furthest-out. Prefer an active row when one exists.
    best_by_user: dict[str, dict] = {}
    for row in rows:
        uid = row.get("app_user_id")
        if not uid or uid not in result:
            continue
        current = best_by_user.get(uid)
        if current is None:
            best_by_user[uid] = row
        elif not _license_is_active(current, now) and _license_is_active(row, now):
            best_by_user[uid] = row

    for uid, row in best_by_user.items():
        result[uid] = _status_from_license(row, now)
    return result


async def is_high_risk_context(app_user_id: str) -> bool:
    """Whether this user flagged a high-risk use during onboarding.

    STAND-IN. The real signal is Wave D's `app_user.onboarding_answer_json`
    (ISSUE-012), which is not present in this worktree. Returning False keeps
    the high-risk Inbox nudge fully dormant so it can never falsely nudge a
    user. The nudge is purely additive — it only appears when this returns
    True AND the user has no active license.

    TODO(wave-d-merge): replace the hardcoded False with a read of
    `app_user.onboarding_answer_json`, deriving high-risk from the stored
    onboarding answer. Until then this is a no-op.
    """
    _ = app_user_id  # unused until the onboarding answer is wired in
    return False


async def has_active_license(app_user_id: str, org_id: Optional[str] = None) -> bool:
    """True when the user currently holds a trained (active, unexpired) license."""
    status = await get_user_training_status(app_user_id, org_id=org_id)
    return bool(status.get("trained"))


async def get_high_risk_pending_action(app_user_id: str) -> Optional[dict]:
    """Return a non-blocking Inbox pending action when a high-risk user has no
    active license, else None.

    Warns, never blocks. The frontend renders this as a yellow-tone pending
    action pointing to training booking. Source is additive so other waves can
    contribute their own pending actions alongside it.
    """
    if not await is_high_risk_context(app_user_id):
        return None
    if await has_active_license(app_user_id):
        return None
    return {
        "code": "training_required_high_risk",
        # User-facing copy. No "AI"; "language model" framing lives in the UI.
        "title": "Training required for high-risk use",
        "message": (
            "You marked a high-risk context. Book a certified training to keep "
            "using dembrane there."
        ),
        "action": "BOOK_TRAINING",
    }


async def provision_license(
    *,
    org_id: str,
    app_user_id: str,
    granted_by: str,
    training_id: Optional[str] = None,
    completed_at: Optional[datetime] = None,
) -> dict:
    """Write a `training_license` row (the verification record) and return it.

    `expires_at` is always `completed_at + 365d`, computed here so no caller can
    drift the compliance window. `granted_by` is the staff user who marked
    completion (audit). `training_id` is optional for a standalone grant.
    """
    completed = completed_at or datetime.now(timezone.utc)
    if completed.tzinfo is None:
        completed = completed.replace(tzinfo=timezone.utc)
    expires = compute_expires_at(completed)
    now_iso = datetime.now(timezone.utc).isoformat()

    payload = {
        "id": generate_uuid(),
        "training_id": training_id,
        "org_id": org_id,
        "app_user_id": app_user_id,
        "completed_at": completed.isoformat(),
        "expires_at": expires.isoformat(),
        "status": "active",
        "granted_by": granted_by,
        "created_at": now_iso,
    }
    created = await async_directus.create_item("training_license", payload)
    # create_item returns {"data": {...}}; unwrap per the Python client contract.
    if isinstance(created, dict) and "data" in created:
        return created["data"]
    return payload
