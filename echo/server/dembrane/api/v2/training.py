"""Training API (ISSUE-020) — catalog, org roster, request, my licenses.

Training is its own dembrane product, separate from billing tiers. Anyone can
get a training; it is only mandated for high-risk users. Booking in v1 is
request + staff provision (no in-app purchase): requesting notifies staff
(Pauline) by email and inbox, and staff provision + complete from the admin
training surface (see admin_training.py).

Mounted at /v2/training.

    GET  /catalog                 — the public training products + pricing
    GET  /orgs/{org_id}/roster    — org members with trained / not-trained status
    POST /orgs/{org_id}/request   — request a training (notifies staff)
    GET  /licenses/me             — the caller's own licenses
"""

from __future__ import annotations

from typing import Literal, Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.training_service import (
    CATALOG,
    get_product,
    is_requestable,
    get_org_roster_training_map,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.training")

# Where training requests land. Pauline owns the training pipeline (ISSUE-020
# Q4). Email is in-product so staff without Directus access still get pinged;
# the inbox notification covers every staff member.
PAULINE_NOTIFY_EMAIL = "pauline@dembrane.com"


# ── Schemas ──────────────────────────────────────────────────────────────


class CatalogProduct(BaseModel):
    type: str
    name: str
    price_eur: int
    included_participants: int
    extra_price_eur: Optional[int] = None
    level: str
    format: str
    grants_license: bool
    coming_soon: bool = False


class RosterEntry(BaseModel):
    """One org member's training status for the admin roster view."""

    app_user_id: str
    display_name: str
    email: Optional[str] = None  # admins only; redacted for non-admins
    role: str
    trained: bool = False
    trained_until: Optional[str] = None
    expiring_soon: bool = False


class OrgRosterResponse(BaseModel):
    org_id: str
    trained_count: int
    total_count: int
    can_manage: bool  # caller is org admin/owner (sees emails, can request)
    members: list[RosterEntry] = []


class RequestTrainingRequest(BaseModel):
    type: Literal["online", "in_person"]  # flex is coming soon; not requestable
    extra_participants: int = Field(default=0, ge=0, le=500)
    notes: Optional[str] = Field(default=None, max_length=2000)


class RequestTrainingResponse(BaseModel):
    training_id: str
    status: str
    type: str
    base_price_eur: float
    extra_price_eur: Optional[float] = None
    estimated_total_eur: float


class LicenseRow(BaseModel):
    id: str
    org_id: Optional[str] = None
    training_id: Optional[str] = None
    completed_at: Optional[str] = None
    expires_at: Optional[str] = None
    status: str
    active: bool  # status=active AND expires_at > now


# ── Helpers ──────────────────────────────────────────────────────────────


async def _require_org_role(org_id: str, app_user_id: str, minimum: str = "member") -> str:
    """Return the caller's org role or raise 403. Mirrors orgs._require_org_role
    so training stays consistent with org-membership access rules."""
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=403, detail="No access to this organisation")
    role = rows[0].get("role", "")
    if minimum == "admin" and role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Organisation admins or owners only")
    return role


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/catalog", response_model=list[CatalogProduct])
async def get_catalog(auth: DependencyDirectusSession) -> list[CatalogProduct]:
    """The training catalog. Single source of truth is training_service.CATALOG
    so the frontend never hardcodes pricing."""
    _ = auth  # auth'd but not org-scoped; the catalog is the same for everyone
    return [
        CatalogProduct(
            type=p.type,
            name=p.name,
            price_eur=p.price_eur,
            included_participants=p.included_participants,
            extra_price_eur=p.extra_price_eur,
            level=p.level,
            format=p.format,
            grants_license=p.grants_license,
            coming_soon=p.coming_soon,
        )
        for p in CATALOG
    ]


@router.get("/orgs/{org_id}/roster", response_model=OrgRosterResponse)
async def get_org_roster(
    org_id: str,
    auth: DependencyDirectusSession,
) -> OrgRosterResponse:
    """Org members with trained / not-trained status + trained-until date.

    Any org member can read it (members can see their own status); only
    admins/owners see emails. The training_license row is the verification
    record (ISSUE-020 both-sides visibility decision).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    can_manage = caller_role in ("admin", "owner")

    memberships = (
        await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["user_id", "role"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(memberships, list):
        memberships = []

    role_by_user = {m["user_id"]: m.get("role", "member") for m in memberships if m.get("user_id")}
    user_ids = list(role_by_user.keys())
    if not user_ids:
        return OrgRosterResponse(
            org_id=org_id, trained_count=0, total_count=0, can_manage=can_manage, members=[]
        )

    app_users = (
        await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "display_name", "email"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(app_users, list):
        app_users = []
    user_map = {u["id"]: u for u in app_users}

    status_map = await get_org_roster_training_map(org_id, user_ids)

    members: list[RosterEntry] = []
    trained_count = 0
    for uid in user_ids:
        u = user_map.get(uid, {})
        status = status_map.get(uid, {})
        is_self = uid == app_user["id"]
        if status.get("trained"):
            trained_count += 1
        members.append(
            RosterEntry(
                app_user_id=uid,
                display_name=u.get("display_name") or "",
                # Email follows the org members redaction rule: admins always,
                # plus a member always sees their own.
                email=(u.get("email") if (can_manage or is_self) else None),
                role=role_by_user.get(uid, "member"),
                trained=bool(status.get("trained")),
                trained_until=status.get("trained_until"),
                expiring_soon=bool(status.get("expiring_soon")),
            )
        )

    members.sort(key=lambda m: (m.display_name or "").lower())
    return OrgRosterResponse(
        org_id=org_id,
        trained_count=trained_count,
        total_count=len(members),
        can_manage=can_manage,
        members=members,
    )


@router.post("/orgs/{org_id}/request", response_model=RequestTrainingResponse)
async def request_training(
    org_id: str,
    body: RequestTrainingRequest,
    auth: DependencyDirectusSession,
) -> RequestTrainingResponse:
    """Request a training for an org. Admin/owner only.

    Creates a `training` row at status=requested and notifies staff (inbox)
    plus Pauline (email). No payment in v1 — staff schedule + provision.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    if not is_requestable(body.type):
        raise HTTPException(status_code=400, detail="This training is not available yet")
    product = get_product(body.type)
    if product is None:
        raise HTTPException(status_code=400, detail="Unknown training type")

    extra_price = product.extra_price_eur
    extra_total = (extra_price or 0) * body.extra_participants
    estimated_total = float(product.price_eur + extra_total)

    now_iso = datetime.now(timezone.utc).isoformat()
    training_id = generate_uuid()
    created = await async_directus.create_item(
        "training",
        {
            "id": training_id,
            "org_id": org_id,
            "type": product.type,
            "included_participants": product.included_participants,
            "extra_participants": body.extra_participants,
            "base_price_eur": float(product.price_eur),
            "extra_price_eur": float(extra_price) if extra_price is not None else None,
            "grants_license": product.grants_license,
            "scheduled_at": None,
            "status": "requested",
            "notes": body.notes,
            "requested_by": app_user["id"],
            "created_at": now_iso,
            "updated_at": now_iso,
        },
    )
    if isinstance(created, dict) and "data" in created:
        training_id = created["data"].get("id", training_id)

    org_row = await async_directus.get_item("org", org_id)
    org_name = (org_row or {}).get("name") or "an organisation"
    requester_name = app_user.get("display_name") or app_user.get("email") or "Someone"

    # Notify staff in-product (inbox) — best-effort, never fails the request.
    try:
        from dembrane.notifications import emit_to_audience, audience_staff

        staff_ids = await audience_staff()
        await emit_to_audience(
            staff_ids,
            actor_user_id=app_user["id"],
            event_code="TRAINING_REQUESTED",
            title=f"{org_name} requested a {product.name} training",
            message=(
                f"{requester_name} requested a {product.name} training "
                f"({body.extra_participants} extra participants). Schedule and provision it."
            ),
            action="NAVIGATE_TRAINING",
            ref_org_id=org_id,
        )
    except Exception:
        logger.exception("training request staff inbox notify failed for org %s", org_id)

    # Notify Pauline by email — best-effort.
    try:
        from dembrane.email import send_email

        admin_base = (get_settings().urls.admin_base_url or "").rstrip("/")
        review_url = f"{admin_base}/admin/training" if admin_base else "/admin/training"
        subject = f"Training requested: {product.name} for {org_name}".replace("\r", " ").replace(
            "\n", " "
        )
        await send_email(
            to=PAULINE_NOTIFY_EMAIL,
            subject=subject,
            plain_text=(
                f"{requester_name} requested a {product.name} training for {org_name}.\n"
                f"Extra participants: {body.extra_participants}\n"
                f"Estimated total: EUR {estimated_total:.0f}\n"
                f"Notes: {body.notes or '(none)'}\n\n"
                f"Review and provision: {review_url}"
            ),
        )
    except Exception:
        logger.exception("training request Pauline email failed for org %s", org_id)

    return RequestTrainingResponse(
        training_id=training_id,
        status="requested",
        type=product.type,
        base_price_eur=float(product.price_eur),
        extra_price_eur=float(extra_price) if extra_price is not None else None,
        estimated_total_eur=estimated_total,
    )


@router.get("/licenses/me", response_model=list[LicenseRow])
async def list_my_licenses(auth: DependencyDirectusSession) -> list[LicenseRow]:
    """The caller's own training licenses (newest expiry first)."""
    app_user = await get_app_user_or_raise(auth.user_id)
    now = datetime.now(timezone.utc)

    rows = await async_directus.get_items(
        "training_license",
        {
            "query": {
                "filter": {"app_user_id": {"_eq": app_user["id"]}},
                "fields": [
                    "id",
                    "org_id",
                    "training_id",
                    "completed_at",
                    "expires_at",
                    "status",
                ],
                "sort": ["-expires_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []

    out: list[LicenseRow] = []
    for r in rows:
        expires = r.get("expires_at")
        active = (r.get("status") or "active") == "active"
        if active and expires:
            try:
                exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                active = exp_dt > now
            except (ValueError, AttributeError):
                active = False
        else:
            active = False
        out.append(
            LicenseRow(
                id=r["id"],
                org_id=r.get("org_id"),
                training_id=r.get("training_id"),
                completed_at=r.get("completed_at"),
                expires_at=expires,
                status=r.get("status") or "active",
                active=active,
            )
        )
    return out
