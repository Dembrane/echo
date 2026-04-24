"""Staff-only admin surface.

Monthly invoicing rollup, at-risk list, partner ledger browse. Gated on
auth.is_admin — the JWT's admin_access claim. Narrower-than-admin staff
policies (staff:can_set_tier, staff:can_transfer) exist in policies.py
but aren't storage-backed yet; everything here is "any Directus admin
can see it" until we wire per-staff policy claims.

Matrix v1.1 §M4 "Internal tooling needed before cutover" drove this:
  - CSV export of all customers (invoice target).
  - Directus view: workspaces approaching hour limit.
  - Directus view: pending upgrade requests with SLA timer.

Those live in product here instead of Directus dashboards so staff
don't need Directus admin access to do the job.
"""
from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.directus_async import async_directus
from dembrane.tier_capacity import get_capacity
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.admin")


# ── Schemas ──


class BillingContact(BaseModel):
    user_id: Optional[str] = None
    display_name: Optional[str] = None
    email: Optional[str] = None


class BillingRow(BaseModel):
    """One row = one workspace's monthly bill."""
    workspace_id: str
    workspace_name: str
    org_id: str
    org_name: str
    tier: str
    is_partner_owned: bool = False
    billed_to_team_id: Optional[str] = None
    billed_to_team_name: Optional[str] = None
    # Usage
    audio_hours: float
    audio_hours_included: Optional[int] = None
    hours_pct: Optional[float] = None
    over_hours: float = 0.0
    hour_overage_eur: float = 0.0
    # Seats
    seat_count: int
    seats_included: Optional[int] = None
    over_seats: int = 0
    seat_overage_eur: float = 0.0
    # Base monthly price (tier sticker). Pilot shows its one-time fee.
    base_price_eur: Optional[float] = None
    total_forecast_eur: Optional[float] = None
    # State flags for at-risk lens
    pilot_hard_block: bool = False
    approaching_cap: bool = False
    at_cap: bool = False
    downgraded_at: Optional[str] = None
    downgraded_from_tier: Optional[str] = None
    # Activity gate. Active = has audio this cycle OR has at least one
    # non-external member. Inactive workspaces are seats that never
    # converted — worth calling staff's attention but not billing risk.
    is_active: bool = True
    # Workspace admins (max 3), preferred over billing-role users so
    # staff has someone to talk to about project issues, not just money.
    workspace_admins: list[BillingContact] = []


class BillingRollupResponse(BaseModel):
    cycle_start: str
    cycle_end_exclusive: str
    workspace_count: int
    total_base_eur: float
    total_overage_eur: float
    total_forecast_eur: float
    rows: list[BillingRow]


class AtRiskRow(BaseModel):
    workspace_id: str
    workspace_name: str
    org_id: str
    org_name: str
    tier: str
    reason: str  # "pilot_hard_block" | "approaching_cap" | "recently_downgraded" | "seat_cap_hit"
    detail: str


# ── Helpers ──


TIER_BASE_PRICE_EUR: dict[str, Optional[float]] = {
    "pilot": 349.0,
    "pioneer": 200.0,
    "innovator": 500.0,
    "changemaker": 1500.0,
    "guardian": 5000.0,
}


def _month_window(now: datetime) -> tuple[str, str]:
    """First of this month → first of next, both UTC ISO."""
    start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    if now.month == 12:
        end = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)
    return start.isoformat(), end.isoformat()


async def _all_active_workspaces() -> list[dict]:
    out = await async_directus.get_items(
        "workspace",
        {"query": {
            "filter": {"deleted_at": {"_null": True}},
            "fields": [
                "id", "name", "tier", "org_id",
                "downgraded_at", "downgraded_from_tier",
                "billed_to_team_id", "effective_client_team_id",
            ],
            "limit": -1,
        }},
    )
    return out if isinstance(out, list) else []


async def _org_name_map(org_ids: list[str]) -> dict[str, str]:
    if not org_ids:
        return {}
    rows = await async_directus.get_items(
        "org",
        {"query": {
            "filter": {"id": {"_in": list(set(org_ids))}},
            "fields": ["id", "name"],
            "limit": -1,
        }},
    )
    if not isinstance(rows, list):
        return {}
    return {r["id"]: r.get("name", "") for r in rows}


async def _workspace_seat_count(ws_id: str) -> int:
    """Members + admins + billing, excluding is_external (matrix §7)."""
    mems = await async_directus.get_items(
        "workspace_membership",
        {"query": {
            "filter": {
                "workspace_id": {"_eq": ws_id},
                "deleted_at": {"_null": True},
                "is_external": {"_eq": False},
            },
            "fields": ["user_id"],
            "limit": -1,
        }},
    )
    if not isinstance(mems, list):
        return 0
    return len({m["user_id"] for m in mems if m.get("user_id")})


async def _workspace_hours_this_cycle(
    ws_id: str, cycle_start: str, cycle_end: str
) -> float:
    """Sum conversation.duration (seconds) → hours for this workspace's
    projects in the current cycle."""
    projects = await async_directus.get_items(
        "project",
        {"query": {
            "filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}},
            "fields": ["id"],
            "limit": -1,
        }},
    )
    if not isinstance(projects, list) or not projects:
        return 0.0
    project_ids = [p["id"] for p in projects if p.get("id")]
    if not project_ids:
        return 0.0
    convs = await async_directus.get_items(
        "conversation",
        {"query": {
            "filter": {
                "project_id": {"_in": project_ids},
                "created_at": {"_gte": cycle_start, "_lt": cycle_end},
                "deleted_at": {"_null": True},
            },
            "fields": ["duration"],
            "limit": -1,
        }},
    )
    if not isinstance(convs, list):
        return 0.0
    total_seconds = sum(float(c.get("duration") or 0) for c in convs)
    return round(total_seconds / 3600.0, 2)


async def _workspace_admins(ws_id: str) -> list[BillingContact]:
    """Workspace admins + owners, max 3. No billing-role fallback.

    Staff wants "who do I call about this workspace" which is the
    admin, not the billing person. Billing-only users are surfaced
    elsewhere if needed.
    """
    mems = await async_directus.get_items(
        "workspace_membership",
        {"query": {
            "filter": {
                "workspace_id": {"_eq": ws_id},
                "deleted_at": {"_null": True},
                "role": {"_in": ["admin", "owner"]},
                "is_external": {"_eq": False},
            },
            "fields": ["user_id"],
            "limit": 3,
        }},
    )
    if not isinstance(mems, list) or not mems:
        return []
    user_ids = [m["user_id"] for m in mems if m.get("user_id")]
    if not user_ids:
        return []
    users = await async_directus.get_items(
        "app_user",
        {"query": {
            "filter": {"id": {"_in": user_ids}},
            "fields": ["id", "display_name", "email"],
            "limit": -1,
        }},
    )
    if not isinstance(users, list):
        return []
    by_id = {u["id"]: u for u in users}
    out: list[BillingContact] = []
    for uid in user_ids:
        u = by_id.get(uid)
        if not u:
            continue
        out.append(
            BillingContact(
                user_id=uid,
                display_name=u.get("display_name"),
                email=u.get("email"),
            )
        )
    return out


# ── Endpoints ──


@router.get("/billing-rollup", response_model=BillingRollupResponse)
async def billing_rollup(
    auth: DependencyDirectusSession,
) -> BillingRollupResponse:
    """Monthly invoicing rollup across every workspace.

    One row per workspace — current cycle hours + seats, overage euros,
    tier sticker price, billing contacts, at-risk flags. Staff uses this
    to generate invoices and spot the workspaces that need a call.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    cycle_start, cycle_end = _month_window(datetime.now(timezone.utc))
    workspaces = await _all_active_workspaces()
    org_ids = [w["org_id"] for w in workspaces if w.get("org_id")]
    org_name_by_id = await _org_name_map(org_ids)

    rows: list[BillingRow] = []
    total_base = 0.0
    total_overage = 0.0

    for ws in workspaces:
        ws_id = ws["id"]
        tier = ws.get("tier", "pioneer")
        cap = get_capacity(tier)
        hours = await _workspace_hours_this_cycle(ws_id, cycle_start, cycle_end)
        seat_count = await _workspace_seat_count(ws_id)

        included_hours = cap.included_hours if cap else None
        included_seats = cap.included_seats if cap else None
        over_hours = max(0.0, hours - included_hours) if included_hours is not None else 0.0
        over_seats = max(0, seat_count - included_seats) if included_seats is not None else 0
        hour_rate = cap.hour_overage_eur if cap else None
        seat_rate = cap.seat_overage_eur if cap else None
        hour_overage_eur = (
            round(over_hours * hour_rate, 2) if hour_rate else 0.0
        )
        seat_overage_eur = (
            round(over_seats * seat_rate, 2) if seat_rate else 0.0
        )
        base_price = TIER_BASE_PRICE_EUR.get(tier)
        total = None
        if base_price is not None:
            total = round(base_price + hour_overage_eur + seat_overage_eur, 2)

        hours_pct = (
            round(hours / included_hours, 3)
            if included_hours
            else None
        )
        pilot_block = (
            bool(cap and cap.hard_block_on_hours and included_hours is not None
                 and hours >= included_hours)
        )
        at_cap = bool(
            not pilot_block and included_hours is not None and hours >= included_hours
        )
        approaching = bool(
            not pilot_block and not at_cap and hours_pct is not None and hours_pct >= 0.8
        )

        billed_to = ws.get("billed_to_team_id") or ws.get("org_id")
        is_partner = (
            ws.get("billed_to_team_id") is not None
            and ws.get("billed_to_team_id") != ws.get("org_id")
        )
        billed_to_name = org_name_by_id.get(billed_to) if billed_to else None

        admins = await _workspace_admins(ws_id)
        # Active when there's usage this cycle OR real members. Everything
        # else is a shell that never turned into an engagement.
        is_active = hours > 0 or seat_count > 0

        row = BillingRow(
            workspace_id=ws_id,
            workspace_name=ws.get("name", ""),
            org_id=ws.get("org_id", ""),
            org_name=org_name_by_id.get(ws.get("org_id", "")) or "",
            tier=tier,
            is_partner_owned=is_partner,
            billed_to_team_id=billed_to,
            billed_to_team_name=billed_to_name,
            audio_hours=hours,
            audio_hours_included=included_hours,
            hours_pct=hours_pct,
            over_hours=round(over_hours, 2),
            hour_overage_eur=hour_overage_eur,
            seat_count=seat_count,
            seats_included=included_seats,
            over_seats=over_seats,
            seat_overage_eur=seat_overage_eur,
            base_price_eur=base_price,
            total_forecast_eur=total,
            pilot_hard_block=pilot_block,
            approaching_cap=approaching,
            at_cap=at_cap,
            downgraded_at=ws.get("downgraded_at"),
            downgraded_from_tier=ws.get("downgraded_from_tier"),
            is_active=is_active,
            workspace_admins=admins,
        )
        rows.append(row)
        if base_price is not None:
            total_base += base_price
        total_overage += hour_overage_eur + seat_overage_eur

    # Sort: at-risk first, then by total forecast desc.
    def _risk(r: BillingRow) -> int:
        if r.pilot_hard_block:
            return 0
        if r.at_cap:
            return 1
        if r.approaching_cap:
            return 2
        return 3
    rows.sort(key=lambda r: (_risk(r), -(r.total_forecast_eur or 0.0)))

    return BillingRollupResponse(
        cycle_start=cycle_start,
        cycle_end_exclusive=cycle_end,
        workspace_count=len(rows),
        total_base_eur=round(total_base, 2),
        total_overage_eur=round(total_overage, 2),
        total_forecast_eur=round(total_base + total_overage, 2),
        rows=rows,
    )


class ReferralLedgerRow(BaseModel):
    """Flattened referral_ledger row with workspace + team names enriched."""
    id: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    partner_team_id: Optional[str] = None
    partner_team_name: Optional[str] = None
    from_org_id: Optional[str] = None
    from_org_name: Optional[str] = None
    partner_kickback_percent: Optional[int] = None
    to_team_discount_percent: Optional[int] = None
    eur_cap_kickback: Optional[float] = None
    starts_at: Optional[str] = None
    expires_at: Optional[str] = None
    notes: Optional[str] = None


@router.get("/referral-ledger", response_model=list[ReferralLedgerRow])
async def list_referral_ledger(
    auth: DependencyDirectusSession,
) -> list[ReferralLedgerRow]:
    """Every row in referral_ledger, enriched with workspace + team names
    so staff can read the table without cross-referencing ids."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    rows = await async_directus.get_items(
        "referral_ledger",
        {"query": {
            "fields": [
                "id", "workspace_id", "partner_team_id", "from_org_id",
                "partner_kickback_percent", "to_team_discount_percent",
                "eur_cap_kickback", "starts_at", "expires_at", "notes",
            ],
            "sort": ["-starts_at"],
            "limit": -1,
        }},
    )
    if not isinstance(rows, list):
        return []

    ws_ids = list({r["workspace_id"] for r in rows if r.get("workspace_id")})
    org_ids = list({
        *(r["partner_team_id"] for r in rows if r.get("partner_team_id")),
        *(r["from_org_id"] for r in rows if r.get("from_org_id")),
    })

    ws_names: dict[str, str] = {}
    if ws_ids:
        ws_rows = await async_directus.get_items(
            "workspace",
            {"query": {
                "filter": {"id": {"_in": ws_ids}},
                "fields": ["id", "name"],
                "limit": -1,
            }},
        )
        if isinstance(ws_rows, list):
            ws_names = {w["id"]: w.get("name", "") for w in ws_rows}

    org_names: dict[str, str] = {}
    if org_ids:
        o_rows = await async_directus.get_items(
            "org",
            {"query": {
                "filter": {"id": {"_in": org_ids}},
                "fields": ["id", "name"],
                "limit": -1,
            }},
        )
        if isinstance(o_rows, list):
            org_names = {o["id"]: o.get("name", "") for o in o_rows}

    out: list[ReferralLedgerRow] = []
    for r in rows:
        out.append(ReferralLedgerRow(
            id=str(r.get("id")),
            workspace_id=r.get("workspace_id"),
            workspace_name=ws_names.get(r.get("workspace_id") or ""),
            partner_team_id=r.get("partner_team_id"),
            partner_team_name=org_names.get(r.get("partner_team_id") or ""),
            from_org_id=r.get("from_org_id"),
            from_org_name=org_names.get(r.get("from_org_id") or ""),
            partner_kickback_percent=r.get("partner_kickback_percent"),
            to_team_discount_percent=r.get("to_team_discount_percent"),
            eur_cap_kickback=r.get("eur_cap_kickback"),
            starts_at=r.get("starts_at"),
            expires_at=r.get("expires_at"),
            notes=r.get("notes"),
        ))
    return out


class UpgradeRequestRow(BaseModel):
    """One pending upgrade request.

    Upgrade requests currently email upgrades@dembrane.com and are not
    persisted. This model is the shape the UI expects once a storage
    collection lands. For now list_upgrade_requests always returns [].
    """
    id: str
    workspace_id: str
    workspace_name: str
    org_id: str
    org_name: str
    current_tier: str
    target_tier: str
    audio_hours_current: float
    audio_hours_included: Optional[int]
    seat_count: int
    seats_included: Optional[int]
    requested_at: str
    requested_by: Optional[str] = None


@router.get("/upgrade-requests", response_model=list[UpgradeRequestRow])
async def list_upgrade_requests(
    auth: DependencyDirectusSession,
) -> list[UpgradeRequestRow]:
    """Pending upgrade requests.

    Today upgrade requests are mailed to upgrades@dembrane.com and never
    persisted; this endpoint returns [] so the UI table renders its
    columns and empty state. Once a persistent upgrade_request collection
    lands (follow-up) we populate from there.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")
    return []


@router.get("/at-risk", response_model=list[AtRiskRow])
async def at_risk(
    auth: DependencyDirectusSession,
) -> list[AtRiskRow]:
    """Workspaces needing attention: pilot-blocked, at-cap, approaching
    cap, or downgraded in the last 14 days.

    Sorted by severity (blocked → at-cap → approaching → downgraded).
    Staff uses this list to decide who needs a call this week.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    rollup = await billing_rollup(auth)
    out: list[AtRiskRow] = []

    now = datetime.now(timezone.utc)
    for r in rollup.rows:
        if r.pilot_hard_block:
            out.append(AtRiskRow(
                workspace_id=r.workspace_id,
                workspace_name=r.workspace_name,
                org_id=r.org_id,
                org_name=r.org_name,
                tier=r.tier,
                reason="pilot_hard_block",
                detail=f"Pilot hit {r.audio_hours:.1f}h of {r.audio_hours_included}h — host-side blocked",
            ))
            continue
        if r.at_cap:
            out.append(AtRiskRow(
                workspace_id=r.workspace_id,
                workspace_name=r.workspace_name,
                org_id=r.org_id,
                org_name=r.org_name,
                tier=r.tier,
                reason="at_cap",
                detail=f"{r.audio_hours:.1f}h / {r.audio_hours_included}h — {r.hour_overage_eur:.0f} EUR overage",
            ))
            continue
        if r.approaching_cap:
            out.append(AtRiskRow(
                workspace_id=r.workspace_id,
                workspace_name=r.workspace_name,
                org_id=r.org_id,
                org_name=r.org_name,
                tier=r.tier,
                reason="approaching_cap",
                detail=f"{r.audio_hours:.1f}h / {r.audio_hours_included}h ({(r.hours_pct or 0) * 100:.0f}%)",
            ))
        if r.downgraded_at:
            # Only surface if within 14 days
            try:
                dt = datetime.fromisoformat(r.downgraded_at.replace("Z", "+00:00"))
                if (now - dt).days <= 14:
                    out.append(AtRiskRow(
                        workspace_id=r.workspace_id,
                        workspace_name=r.workspace_name,
                        org_id=r.org_id,
                        org_name=r.org_name,
                        tier=r.tier,
                        reason="recently_downgraded",
                        detail=f"Downgraded {dt.strftime('%Y-%m-%d')} from {r.downgraded_from_tier}",
                    ))
            except Exception:
                pass
    return out
