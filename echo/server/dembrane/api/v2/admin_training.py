"""Staff training tools (ISSUE-020) — separate router to keep admin.py untouched.

Staff create/schedule trainings, mark users completed (which writes the
one-year `training_license` verification rows), and edit / revoke licenses.
Every endpoint is gated on `auth.is_admin` (the Directus admin_access claim),
mirroring admin.py's staff gate.

Mounted at /v2/admin/trainings. This wires into ISSUE-022's empty `training`
Tabs.Panel placeholder in AdminSettingsRoute at integration; the panel calls
these endpoints.

    GET    /trainings                      — list trainings (filter by org/status)
    POST   /trainings                      — create a training for an org
    PATCH  /trainings/{id}                 — edit type/schedule/status/participants
    GET    /trainings/orgs/{org_id}/roster — an org's training roster (staff view)
    GET    /trainings/{id}/licenses        — licenses a training granted (with names)
    POST   /trainings/{id}/complete        — mark users completed → write licenses
    PATCH  /licenses/{id}                  — edit completion date / status
    POST   /licenses/{id}/revoke           — revoke a license
"""

from __future__ import annotations

from typing import Literal, Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.utils import generate_uuid
from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.training_service import (
    get_product,
    provision_license,
    compute_expires_at,
    get_org_roster_training_map,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.admin_training")


def _require_staff(auth: DependencyDirectusSession) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")


# ── Schemas ──────────────────────────────────────────────────────────────


class TrainingRow(BaseModel):
    id: str
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    type: str
    included_participants: int = 0
    extra_participants: int = 0
    base_price_eur: Optional[float] = None
    extra_price_eur: Optional[float] = None
    grants_license: bool = False
    scheduled_at: Optional[str] = None
    status: str
    notes: Optional[str] = None
    requested_by: Optional[str] = None
    requested_by_name: Optional[str] = None
    requested_by_email: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    license_count: int = 0
    org_member_count: int = 0


class TrainingLicenseRow(BaseModel):
    id: str
    app_user_id: str
    app_user_name: Optional[str] = None
    app_user_email: Optional[str] = None
    status: str
    completed_at: Optional[str] = None
    expires_at: Optional[str] = None


class CreateTrainingRequest(BaseModel):
    org_id: str
    type: Literal["online", "in_person", "flex"]
    extra_participants: int = Field(default=0, ge=0, le=500)
    scheduled_at: Optional[str] = None
    notes: Optional[str] = Field(default=None, max_length=2000)
    # Override the catalog base price when staff agreed a custom fee offline.
    base_price_eur: Optional[float] = Field(default=None, ge=0)


class UpdateTrainingRequest(BaseModel):
    type: Optional[Literal["online", "in_person", "flex"]] = None
    status: Optional[Literal["requested", "scheduled", "completed", "cancelled"]] = None
    scheduled_at: Optional[str] = None
    extra_participants: Optional[int] = Field(default=None, ge=0, le=500)
    notes: Optional[str] = Field(default=None, max_length=2000)


class CompleteTrainingRequest(BaseModel):
    """Mark users completed → write one-year licenses. `completed_at` defaults
    to now; staff can backdate (the trained-at date)."""

    app_user_ids: list[str] = Field(min_length=1)
    completed_at: Optional[str] = None


class LicenseAdminRow(BaseModel):
    id: str
    org_id: Optional[str] = None
    training_id: Optional[str] = None
    app_user_id: str
    completed_at: Optional[str] = None
    expires_at: Optional[str] = None
    status: str
    granted_by: Optional[str] = None


class UpdateLicenseRequest(BaseModel):
    """Edit the trained-at date (recomputes expiry) or the status."""

    completed_at: Optional[str] = None
    status: Optional[Literal["active", "expired", "revoked"]] = None


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


# ── Trainings ────────────────────────────────────────────────────────────


@router.get("/trainings", response_model=list[TrainingRow])
async def list_trainings(
    auth: DependencyDirectusSession,
    org_id: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
) -> list[TrainingRow]:
    """List trainings, optionally filtered by org or status. Newest first."""
    _require_staff(auth)

    filter_: dict = {}
    if org_id:
        filter_["org_id"] = {"_eq": org_id}
    if status:
        filter_["status"] = {"_eq": status}

    rows = await async_directus.get_items(
        "training",
        {
            "query": {
                "filter": filter_,
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return []

    org_ids = list({r["org_id"] for r in rows if r.get("org_id")})
    org_name_map: dict[str, str] = {}
    if org_ids:
        orgs = await async_directus.get_items(
            "org",
            {"query": {"filter": {"id": {"_in": org_ids}}, "fields": ["id", "name"], "limit": -1}},
        )
        if isinstance(orgs, list):
            org_name_map = {o["id"]: o.get("name", "") for o in orgs}

    # Member count per org: the denominator for "fully completed" (active
    # licenses must cover all members, not the larger seat capacity).
    member_count_map: dict[str, int] = {oid: 0 for oid in org_ids}
    if org_ids:
        memberships = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {"org_id": {"_in": org_ids}, "deleted_at": {"_null": True}},
                    "fields": ["org_id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(memberships, list):
            for m in memberships:
                oid = m.get("org_id")
                if oid in member_count_map:
                    member_count_map[oid] += 1

    requester_ids = list({r["requested_by"] for r in rows if r.get("requested_by")})
    requester_map: dict[str, dict] = {}
    if requester_ids:
        users = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": requester_ids}},
                    "fields": ["id", "display_name", "email"],
                    "limit": -1,
                }
            },
        )
        if isinstance(users, list):
            requester_map = {u["id"]: u for u in users}

    training_ids = [r["id"] for r in rows if r.get("id")]
    license_count_map: dict[str, int] = {tid: 0 for tid in training_ids}
    if training_ids:
        lic = await async_directus.get_items(
            "training_license",
            {
                "query": {
                    "filter": {"training_id": {"_in": training_ids}},
                    "fields": ["training_id", "status"],
                    "limit": -1,
                }
            },
        )
        if isinstance(lic, list):
            # Count only active licenses; a revoked one no longer means trained.
            for row in lic:
                tid = row.get("training_id")
                if tid in license_count_map and row.get("status") == "active":
                    license_count_map[tid] += 1

    return [
        TrainingRow(
            id=r["id"],
            org_id=r.get("org_id"),
            org_name=org_name_map.get(r.get("org_id", "")),
            type=r.get("type", ""),
            included_participants=int(r.get("included_participants") or 0),
            extra_participants=int(r.get("extra_participants") or 0),
            base_price_eur=r.get("base_price_eur"),
            extra_price_eur=r.get("extra_price_eur"),
            grants_license=bool(r.get("grants_license")),
            scheduled_at=r.get("scheduled_at"),
            status=r.get("status", ""),
            notes=r.get("notes"),
            requested_by=r.get("requested_by"),
            requested_by_name=(requester_map.get(r.get("requested_by") or "") or {}).get(
                "display_name"
            ),
            requested_by_email=(requester_map.get(r.get("requested_by") or "") or {}).get(
                "email"
            ),
            created_at=r.get("created_at"),
            updated_at=r.get("updated_at"),
            license_count=license_count_map.get(r["id"], 0),
            org_member_count=member_count_map.get(r.get("org_id", ""), 0),
        )
        for r in rows
    ]


@router.post("/trainings", response_model=TrainingRow)
async def create_training(
    body: CreateTrainingRequest,
    auth: DependencyDirectusSession,
) -> TrainingRow:
    """Create a training for an org (staff-provisioned). Pulls catalog defaults
    for the type; staff may override the base price."""
    _require_staff(auth)
    await get_app_user_or_raise(auth.user_id)  # ensure the staff user has an app_user row

    product = get_product(body.type)
    if product is None:
        raise HTTPException(status_code=400, detail="Unknown training type")

    org_row = await async_directus.get_item("org", body.org_id)
    if not org_row or org_row.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Organisation not found")

    base_price = body.base_price_eur if body.base_price_eur is not None else float(product.price_eur)
    now_iso = datetime.now(timezone.utc).isoformat()
    training_id = generate_uuid()
    status = "scheduled" if body.scheduled_at else "requested"

    payload = {
        "id": training_id,
        "org_id": body.org_id,
        "type": product.type,
        "included_participants": product.included_participants,
        "extra_participants": body.extra_participants,
        "base_price_eur": base_price,
        "extra_price_eur": (
            float(product.extra_price_eur) if product.extra_price_eur is not None else None
        ),
        "grants_license": product.grants_license,
        "scheduled_at": body.scheduled_at,
        "status": status,
        "notes": body.notes,
        "requested_by": None,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    created = await async_directus.create_item("training", payload)
    if isinstance(created, dict) and "data" in created:
        training_id = created["data"].get("id", training_id)

    return TrainingRow(
        id=training_id,
        org_id=body.org_id,
        org_name=org_row.get("name"),
        type=product.type,
        included_participants=product.included_participants,
        extra_participants=body.extra_participants,
        base_price_eur=base_price,
        extra_price_eur=(
            float(product.extra_price_eur) if product.extra_price_eur is not None else None
        ),
        grants_license=product.grants_license,
        scheduled_at=body.scheduled_at,
        status=status,
        notes=body.notes,
        created_at=now_iso,
        updated_at=now_iso,
        license_count=0,
    )


@router.patch("/trainings/{training_id}")
async def update_training(
    training_id: str,
    body: UpdateTrainingRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Edit a training's type / schedule / status / participants."""
    _require_staff(auth)

    existing = await async_directus.get_item("training", training_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Training not found")

    payload: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if body.type is not None:
        product = get_product(body.type)
        if product is None:
            raise HTTPException(status_code=400, detail="Unknown training type")
        payload["type"] = body.type
        payload["grants_license"] = product.grants_license
        payload["included_participants"] = product.included_participants
    if body.status is not None:
        payload["status"] = body.status
    if body.scheduled_at is not None:
        payload["scheduled_at"] = body.scheduled_at
    if body.extra_participants is not None:
        payload["extra_participants"] = body.extra_participants
    if body.notes is not None:
        payload["notes"] = body.notes

    await async_directus.update_item("training", training_id, payload)
    return {"status": "success"}


@router.get("/trainings/orgs/{org_id}/roster")
async def staff_org_roster(
    org_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """An org's training roster from the staff side. Same trained/not-trained
    map the org admin sees, with emails always visible to staff."""
    _require_staff(auth)

    memberships = (
        await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
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
        return {"org_id": org_id, "trained_count": 0, "total_count": 0, "members": []}

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
    user_map = {u["id"]: u for u in app_users} if isinstance(app_users, list) else {}
    status_map = await get_org_roster_training_map(org_id, user_ids)

    members = []
    trained = 0
    for uid in user_ids:
        u = user_map.get(uid, {})
        st = status_map.get(uid, {})
        if st.get("trained"):
            trained += 1
        members.append(
            {
                "app_user_id": uid,
                "display_name": u.get("display_name") or "",
                "email": u.get("email"),
                "role": role_by_user.get(uid, "member"),
                "trained": bool(st.get("trained")),
                "trained_until": st.get("trained_until"),
                "expiring_soon": bool(st.get("expiring_soon")),
            }
        )
    members.sort(key=lambda m: (m["display_name"] or "").lower())
    return {
        "org_id": org_id,
        "trained_count": trained,
        "total_count": len(members),
        "members": members,
    }


@router.get("/trainings/{training_id}/licenses", response_model=list[TrainingLicenseRow])
async def list_training_licenses(
    training_id: str,
    auth: DependencyDirectusSession,
) -> list[TrainingLicenseRow]:
    """The licenses granted by a training, with attendee names resolved. Used by
    staff to review and revoke completions. Newest first."""
    _require_staff(auth)

    rows = await async_directus.get_items(
        "training_license",
        {
            "query": {
                "filter": {"training_id": {"_eq": training_id}},
                "sort": ["-completed_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return []

    user_ids = list({r["app_user_id"] for r in rows if r.get("app_user_id")})
    user_map: dict[str, dict] = {}
    if user_ids:
        users = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "display_name", "email"],
                    "limit": -1,
                }
            },
        )
        if isinstance(users, list):
            user_map = {u["id"]: u for u in users}

    return [
        TrainingLicenseRow(
            id=r["id"],
            app_user_id=r.get("app_user_id", ""),
            app_user_name=(user_map.get(r.get("app_user_id") or "") or {}).get(
                "display_name"
            ),
            app_user_email=(user_map.get(r.get("app_user_id") or "") or {}).get("email"),
            status=r.get("status", ""),
            completed_at=r.get("completed_at"),
            expires_at=r.get("expires_at"),
        )
        for r in rows
    ]


@router.post("/trainings/{training_id}/complete")
async def complete_training(
    training_id: str,
    body: CompleteTrainingRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Mark users completed: write a one-year `training_license` per user and
    flip the training to completed. `granted_by` is the staff user (audit)."""
    _require_staff(auth)
    staff_user = await get_app_user_or_raise(auth.user_id)

    training = await async_directus.get_item("training", training_id)
    if not training:
        raise HTTPException(status_code=404, detail="Training not found")
    if not training.get("grants_license"):
        raise HTTPException(
            status_code=400, detail="This training type does not grant a license"
        )

    org_id = training.get("org_id")
    completed_at = _parse_iso(body.completed_at) or datetime.now(timezone.utc)

    created_ids: list[str] = []
    for uid in body.app_user_ids:
        license_row = await provision_license(
            org_id=org_id,
            app_user_id=uid,
            granted_by=staff_user["id"],
            training_id=training_id,
            completed_at=completed_at,
        )
        created_ids.append(license_row.get("id", ""))

        # Notify the trained user — best-effort.
        try:
            from dembrane.notifications import emit

            await emit(
                audience_user_id=uid,
                actor_user_id=staff_user["id"],
                event_code="TRAINING_COMPLETED",
                title="Your training is complete",
                message="You now hold a one-year license to use dembrane in high-risk settings.",
                action="NAVIGATE_TRAINING",
                ref_org_id=org_id,
            )
        except Exception:
            logger.exception("training completion notify failed for user %s", uid)

    await async_directus.update_item(
        "training",
        training_id,
        {"status": "completed", "updated_at": datetime.now(timezone.utc).isoformat()},
    )

    return {"status": "success", "license_ids": created_ids, "licenses_created": len(created_ids)}


# ── Licenses ─────────────────────────────────────────────────────────────


@router.patch("/licenses/{license_id}", response_model=LicenseAdminRow)
async def update_license(
    license_id: str,
    body: UpdateLicenseRequest,
    auth: DependencyDirectusSession,
) -> LicenseAdminRow:
    """Edit a license: change the trained-at date (recomputes the one-year
    expiry) or set the status."""
    _require_staff(auth)

    existing = await async_directus.get_item("training_license", license_id)
    if not existing:
        raise HTTPException(status_code=404, detail="License not found")

    payload: dict = {}
    if body.completed_at is not None:
        completed = _parse_iso(body.completed_at)
        if completed is None:
            raise HTTPException(status_code=400, detail="Invalid completed_at")
        payload["completed_at"] = completed.isoformat()
        # Expiry is always derived — never let staff set it directly.
        payload["expires_at"] = compute_expires_at(completed).isoformat()
    if body.status is not None:
        payload["status"] = body.status

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("training_license", license_id, payload)
    merged = {**existing, **payload}
    return LicenseAdminRow(
        id=license_id,
        org_id=merged.get("org_id"),
        training_id=merged.get("training_id"),
        app_user_id=merged.get("app_user_id", ""),
        completed_at=merged.get("completed_at"),
        expires_at=merged.get("expires_at"),
        status=merged.get("status", "active"),
        granted_by=merged.get("granted_by"),
    )


@router.post("/licenses/{license_id}/revoke")
async def revoke_license(
    license_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Revoke a license (sets status=revoked; it stops counting as trained)."""
    _require_staff(auth)

    existing = await async_directus.get_item("training_license", license_id)
    if not existing:
        raise HTTPException(status_code=404, detail="License not found")

    await async_directus.update_item("training_license", license_id, {"status": "revoked"})

    # If no active licenses remain, the training is no longer completed, so move
    # it back to scheduled (if dated) or requested.
    training_id = existing.get("training_id")
    if training_id:
        remaining = await async_directus.get_items(
            "training_license",
            {
                "query": {
                    "filter": {
                        "training_id": {"_eq": training_id},
                        "status": {"_eq": "active"},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        has_active = isinstance(remaining, list) and len(remaining) > 0
        if not has_active:
            training = await async_directus.get_item("training", training_id)
            if training and training.get("status") == "completed":
                await async_directus.update_item(
                    "training",
                    training_id,
                    {
                        "status": "scheduled"
                        if training.get("scheduled_at")
                        else "requested",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                )

    return {"status": "success"}
