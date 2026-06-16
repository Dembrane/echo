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

from typing import Literal, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from fastapi import Query, APIRouter, HTTPException, BackgroundTasks
from pydantic import Field, BaseModel

from dembrane.email import send_email
from dembrane.settings import get_settings
from dembrane.notifications import emit
from dembrane.seat_capacity import compute_effective_seat_state
from dembrane.tier_capacity import get_capacity
from dembrane.directus_async import async_directus
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
    # Externals share the main seat pool. Count exposed for visibility.
    external_count: int = 0
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
    # seat occupied (member or external). Inactive workspaces are seats
    # that never converted — worth calling staff's attention but not
    # billing risk.
    is_active: bool = True
    # Workspace admins (max 3), preferred over billing-role users so
    # staff has someone to talk to about project issues, not just money.
    workspace_admins: list[BillingContact] = []
    # Discount + expiry metadata for CSV export
    tier_expires_at: Optional[str] = None
    type_discount: Optional[str] = None
    percent_discount: Optional[int] = None
    # Cadence derived from the workspace's most-recently approved
    # workspace_request. `None` for legacy workspaces.
    billing_period: Optional[str] = None


class BillingRollupResponse(BaseModel):
    cycle_start: str
    cycle_end_exclusive: str
    workspace_count: int
    active_workspace_count: int
    total_base_eur: float
    total_overage_eur: float
    total_forecast_eur: float
    # MRR = sum of (active workspace base prices) for non-pilot tiers.
    # Pilot is one-time so its base doesn't recur; excluded from MRR
    # but included in total_forecast_eur as this-month revenue.
    mrr_eur: float
    # Count of workspace admins (non-external, admin+owner) who logged
    # in in the last 30 days. Proxy for "active accounts you can
    # reach" since we don't have a full DAU pipeline.
    logins_last_30d: int
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


def _month_window(now: datetime, offset: int = 0) -> tuple[str, str]:
    """First of (this month + offset) to first of the following month.

    offset=0 means the current calendar month. offset=-1 means the
    previous month. Staff flips between them from the period selector.
    """
    # Walk the month one at a time so we correctly handle year rollovers
    # in both directions.
    year, month = now.year, now.month
    month += offset
    while month < 1:
        month += 12
        year -= 1
    while month > 12:
        month -= 12
        year += 1
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start.isoformat(), end.isoformat()


async def _recent_login_count(since_iso: str) -> int:
    """Admins/owners (non-external) with a Directus users.last_access
    newer than `since_iso`. Returns 0 on any error so the headline
    doesn't blow up if the join fails."""
    try:
        rows = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "fields": ["id", "directus_user_id"],
                    "filter": {"directus_user_id": {"_nnull": True}},
                    "limit": -1,
                }
            },
        )
        if not isinstance(rows, list):
            return 0
        directus_ids = [r["directus_user_id"] for r in rows if r.get("directus_user_id")]
        if not directus_ids:
            return 0
        users = await async_directus.get_users(
            {
                "query": {
                    "filter": {
                        "id": {"_in": directus_ids[:500]},
                        "last_access": {"_gte": since_iso},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        return len(users) if isinstance(users, list) else 0
    except Exception:  # noqa: BLE001 — best-effort headline metric
        return 0


async def _all_active_workspaces() -> list[dict]:
    from dembrane.billing_account import nested_billing_fields, billing_from_workspace

    out = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"deleted_at": {"_null": True}},
                "fields": [
                    "id",
                    "name",
                    "org_id",
                    "billed_to_team_id",
                    "effective_client_team_id",
                    *nested_billing_fields(),
                ],
                "limit": -1,
            }
        },
    )
    if not isinstance(out, list):
        return []
    # Flatten the joined billing account fields to the top level so callers
    # read ws["tier"], ws["downgraded_at"], etc. unchanged.
    for ws in out:
        ws.update(billing_from_workspace(ws))
    return out


async def _org_name_map(org_ids: list[str]) -> dict[str, str]:
    if not org_ids:
        return {}
    rows = await async_directus.get_items(
        "org",
        {
            "query": {
                "filter": {"id": {"_in": list(set(org_ids))}},
                "fields": ["id", "name"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return {}
    return {r["id"]: r.get("name", "") for r in rows}


async def _workspace_hours_this_cycle(ws_id: str, cycle_start: str, cycle_end: str) -> float:
    """Sum conversation.duration (seconds) → hours for this workspace's
    projects in the current cycle."""
    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list) or not projects:
        return 0.0
    project_ids = [p["id"] for p in projects if p.get("id")]
    if not project_ids:
        return 0.0
    convs = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": {"_in": project_ids},
                    "created_at": {"_gte": cycle_start, "_lt": cycle_end},
                    "deleted_at": {"_null": True},
                },
                "fields": ["duration"],
                "limit": -1,
            }
        },
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
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ws_id},
                    "deleted_at": {"_null": True},
                    "role": {"_in": ["admin", "owner"]},
                },
                "fields": ["user_id"],
                "limit": 3,
            }
        },
    )
    if not isinstance(mems, list) or not mems:
        return []
    user_ids = [m["user_id"] for m in mems if m.get("user_id")]
    if not user_ids:
        return []
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
    month_offset: int = Query(
        default=0,
        ge=-12,
        le=0,
        description=(
            "0 = current month, -1 = previous month, ..., -12 = one year "
            "ago. Positive values rejected because future months don't bill."
        ),
    ),
) -> BillingRollupResponse:
    """Monthly invoicing rollup across every workspace.

    One row per workspace for the selected calendar month: hours +
    seats used, overage euros, tier sticker price, workspace admins,
    at-risk flags. Headline totals + MRR + logins also returned for
    the KPI row on the admin surface.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    cycle_start, cycle_end = _month_window(datetime.now(timezone.utc), month_offset)
    workspaces = await _all_active_workspaces()
    org_ids = [w["org_id"] for w in workspaces if w.get("org_id")]
    org_name_by_id = await _org_name_map(org_ids)

    # Batch-resolve cadence for every workspace in one Directus query.
    # Per-workspace lookups would be N+1 against the request table.
    from dembrane.billing_period import resolve_workspace_billing_periods

    workspace_billing_periods = await resolve_workspace_billing_periods(
        [w["id"] for w in workspaces if w.get("id")]
    )

    rows: list[BillingRow] = []
    total_base = 0.0
    total_overage = 0.0

    for ws in workspaces:
        ws_id = ws["id"]
        tier = ws.get("tier", "pioneer")
        cap = get_capacity(tier)
        hours = await _workspace_hours_this_cycle(ws_id, cycle_start, cycle_end)
        # Use the unified inheritance-aware count so billing arithmetic
        # matches what enforcement/usage endpoints see (derived org admins
        # included). Direct workspace_membership queries miss derived rows
        # and would understate over_seats/seat_overage_eur.
        _seats_used, seat_count, external_count = await compute_effective_seat_state(ws_id)

        included_hours = cap.included_hours if cap else None
        included_seats = cap.included_seats if cap else None
        over_hours = max(0.0, hours - included_hours) if included_hours is not None else 0.0
        unified_seats = seat_count + external_count
        over_seats = max(0, unified_seats - included_seats) if included_seats is not None else 0
        hour_rate = cap.hour_overage_eur if cap else None
        seat_rate = cap.seat_overage_eur if cap else None
        hour_overage_eur = round(over_hours * hour_rate, 2) if hour_rate else 0.0
        seat_overage_eur = round(over_seats * seat_rate, 2) if seat_rate else 0.0
        base_price = TIER_BASE_PRICE_EUR.get(tier)
        total = None
        if base_price is not None:
            total = round(base_price + hour_overage_eur + seat_overage_eur, 2)

        hours_pct = round(hours / included_hours, 3) if included_hours else None
        pilot_block = bool(
            cap
            and cap.hard_block_on_hours
            and included_hours is not None
            and hours >= included_hours
        )
        at_cap = bool(not pilot_block and included_hours is not None and hours >= included_hours)
        approaching = bool(
            not pilot_block and not at_cap and hours_pct is not None and hours_pct >= 0.8
        )

        billed_to = ws.get("billed_to_team_id") or ws.get("org_id")
        is_partner = ws.get("billed_to_team_id") is not None and ws.get(
            "billed_to_team_id"
        ) != ws.get("org_id")
        billed_to_name = org_name_by_id.get(billed_to) if billed_to else None

        admins = await _workspace_admins(ws_id)
        # Active when there's usage this cycle OR real members. Everything
        # else is a shell that never turned into an engagement.
        is_active = hours > 0 or seat_count > 0 or external_count > 0

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
            external_count=external_count,
            base_price_eur=base_price,
            total_forecast_eur=total,
            pilot_hard_block=pilot_block,
            approaching_cap=approaching,
            at_cap=at_cap,
            downgraded_at=ws.get("downgraded_at"),
            downgraded_from_tier=ws.get("downgraded_from_tier"),
            is_active=is_active,
            workspace_admins=admins,
            tier_expires_at=ws.get("tier_expires_at"),
            type_discount=ws.get("type_discount"),
            percent_discount=ws.get("percent_discount"),
            billing_period=workspace_billing_periods.get(ws_id),
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

    # MRR: sum of recurring (non-pilot) base prices of ACTIVE workspaces.
    # Pilot is one-time so it's pure revenue-this-month, not ARR-like.
    mrr = 0.0
    for r in rows:
        if r.is_active and r.tier != "pilot" and r.base_price_eur:
            mrr += r.base_price_eur

    active_count = sum(1 for r in rows if r.is_active)

    # Last 30 days of calendar time, not the selected period.
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    logins_30d = await _recent_login_count(since)

    return BillingRollupResponse(
        cycle_start=cycle_start,
        cycle_end_exclusive=cycle_end,
        workspace_count=len(rows),
        active_workspace_count=active_count,
        total_base_eur=round(total_base, 2),
        total_overage_eur=round(total_overage, 2),
        total_forecast_eur=round(total_base + total_overage, 2),
        mrr_eur=round(mrr, 2),
        logins_last_30d=logins_30d,
        rows=rows,
    )


class ReferralLedgerRow(BaseModel):
    """Flattened referral_ledger row with workspace + organisation names enriched."""

    id: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    partner_team_id: Optional[str] = None
    partner_team_name: Optional[str] = None
    from_org_id: Optional[str] = None
    from_org_name: Optional[str] = None
    partner_kickback_percent: Optional[int] = None
    to_organisation_discount_percent: Optional[int] = None
    eur_cap_kickback: Optional[float] = None
    starts_at: Optional[str] = None
    expires_at: Optional[str] = None
    notes: Optional[str] = None


@router.get("/referral-ledger", response_model=list[ReferralLedgerRow])
async def list_referral_ledger(
    auth: DependencyDirectusSession,
) -> list[ReferralLedgerRow]:
    """Every row in referral_ledger, enriched with workspace + organisation names
    so staff can read the table without cross-referencing ids."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    rows = await async_directus.get_items(
        "referral_ledger",
        {
            "query": {
                "fields": [
                    "id",
                    "workspace_id",
                    "partner_team_id",
                    "from_org_id",
                    "partner_kickback_percent",
                    "to_organisation_discount_percent",
                    "eur_cap_kickback",
                    "starts_at",
                    "expires_at",
                    "notes",
                ],
                "sort": ["-starts_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []

    ws_ids = list({r["workspace_id"] for r in rows if r.get("workspace_id")})
    org_ids = list(
        {
            *(r["partner_team_id"] for r in rows if r.get("partner_team_id")),
            *(r["from_org_id"] for r in rows if r.get("from_org_id")),
        }
    )

    ws_names: dict[str, str] = {}
    if ws_ids:
        ws_rows = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {"id": {"_in": ws_ids}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(ws_rows, list):
            ws_names = {w["id"]: w.get("name", "") for w in ws_rows}

    org_names: dict[str, str] = {}
    if org_ids:
        o_rows = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": org_ids}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(o_rows, list):
            org_names = {o["id"]: o.get("name", "") for o in o_rows}

    out: list[ReferralLedgerRow] = []
    for r in rows:
        out.append(
            ReferralLedgerRow(
                id=str(r.get("id")),
                workspace_id=r.get("workspace_id"),
                workspace_name=ws_names.get(r.get("workspace_id") or ""),
                partner_team_id=r.get("partner_team_id"),
                partner_team_name=org_names.get(r.get("partner_team_id") or ""),
                from_org_id=r.get("from_org_id"),
                from_org_name=org_names.get(r.get("from_org_id") or ""),
                partner_kickback_percent=r.get("partner_kickback_percent"),
                to_organisation_discount_percent=r.get("to_organisation_discount_percent"),
                eur_cap_kickback=r.get("eur_cap_kickback"),
                starts_at=r.get("starts_at"),
                expires_at=r.get("expires_at"),
                notes=r.get("notes"),
            )
        )
    return out


class WorkspaceRequestRequester(BaseModel):
    id: str
    display_name: Optional[str] = None
    email: Optional[str] = None


class WorkspaceRequestRow(BaseModel):
    id: str
    kind: str
    status: str
    requester: Optional[WorkspaceRequestRequester] = None
    org_id: str
    org_name: Optional[str] = None
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    proposed_name: Optional[str] = None
    proposed_tier: str
    proposed_visibility: Optional[str] = None
    proposed_billing_period: Optional[Literal["annual", "monthly"]] = None
    requester_message: Optional[str] = None
    granted_tier: Optional[str] = None
    granted_tier_expires_at: Optional[str] = None
    granted_type_discount: Optional[str] = None
    granted_percent_discount: Optional[int] = None
    approved_billing_period: Optional[Literal["annual", "monthly"]] = None
    resulting_workspace_id: Optional[str] = None
    decided_at: Optional[str] = None
    decided_by: Optional[WorkspaceRequestRequester] = None
    denial_reason: Optional[str] = None
    staff_notes: Optional[str] = None
    created_at: Optional[str] = None


class WorkspaceRequestListResponse(BaseModel):
    items: list[WorkspaceRequestRow]
    counts: dict[str, int]


async def _enrich_workspace_requests(
    rows: list[dict],
) -> list[WorkspaceRequestRow]:
    """Enrich raw workspace_request rows with requester, org, workspace names."""
    if not rows:
        return []

    user_ids = list(
        {uid for r in rows for uid in [r.get("requested_by"), r.get("decided_by")] if uid}
    )
    org_ids = list({r["org_id"] for r in rows if r.get("org_id")})
    ws_ids = list(
        {
            wid
            for r in rows
            for wid in [r.get("workspace_id"), r.get("resulting_workspace_id")]
            if wid
        }
    )

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

    org_map: dict[str, str] = {}
    if org_ids:
        orgs = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": org_ids}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(orgs, list):
            org_map = {o["id"]: o.get("name", "") for o in orgs}

    ws_map: dict[str, str] = {}
    if ws_ids:
        wss = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {"id": {"_in": ws_ids}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(wss, list):
            ws_map = {w["id"]: w.get("name", "") for w in wss}

    def _user(uid: Optional[str]) -> Optional[WorkspaceRequestRequester]:
        if not uid:
            return None
        u = user_map.get(uid)
        if not u:
            return WorkspaceRequestRequester(id=uid)
        return WorkspaceRequestRequester(
            id=uid,
            display_name=u.get("display_name"),
            email=u.get("email"),
        )

    out: list[WorkspaceRequestRow] = []
    for r in rows:
        out.append(
            WorkspaceRequestRow(
                id=r["id"],
                kind=r.get("kind", ""),
                status=r.get("status", "pending"),
                requester=_user(r.get("requested_by")),
                org_id=r.get("org_id", ""),
                org_name=org_map.get(r.get("org_id", "")),
                workspace_id=r.get("workspace_id"),
                workspace_name=ws_map.get(r.get("workspace_id", "")),
                proposed_name=r.get("proposed_name"),
                proposed_tier=r.get("proposed_tier", "innovator"),
                proposed_visibility=r.get("proposed_visibility"),
                proposed_billing_period=r.get("proposed_billing_period"),
                requester_message=r.get("requester_message"),
                granted_tier=r.get("granted_tier"),
                granted_tier_expires_at=r.get("granted_tier_expires_at"),
                granted_type_discount=r.get("granted_type_discount"),
                granted_percent_discount=r.get("granted_percent_discount"),
                approved_billing_period=r.get("approved_billing_period"),
                resulting_workspace_id=r.get("resulting_workspace_id"),
                decided_at=r.get("decided_at"),
                decided_by=_user(r.get("decided_by")),
                denial_reason=r.get("denial_reason"),
                staff_notes=r.get("staff_notes"),
                created_at=r.get("created_at"),
            )
        )
    return out


@router.get("/workspace-requests", response_model=WorkspaceRequestListResponse)
async def list_workspace_requests(
    auth: DependencyDirectusSession,
    status: Optional[str] = Query(
        default=None,
        description="Filter by status: pending, approved, denied. Omit for all.",
    ),
) -> WorkspaceRequestListResponse:
    """All workspace requests (new workspace + tier upgrade).

    Staff-only. Filterable by status. Sorted by created_at descending.
    Returns items plus per-status counts for tab badges.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    base_filter: dict = {}
    if status and status in ("pending", "approved", "denied"):
        base_filter["status"] = {"_eq": status}

    rows = await async_directus.get_items(
        "workspace_request",
        {
            "query": {
                "filter": base_filter if base_filter else {},
                "fields": [
                    "id",
                    "kind",
                    "status",
                    "requested_by",
                    "org_id",
                    "workspace_id",
                    "proposed_name",
                    "proposed_tier",
                    "proposed_visibility",
                    "proposed_billing_period",
                    "requester_message",
                    "granted_tier",
                    "granted_tier_expires_at",
                    "granted_type_discount",
                    "granted_percent_discount",
                    "approved_billing_period",
                    "resulting_workspace_id",
                    "decided_at",
                    "decided_by",
                    "denial_reason",
                    "staff_notes",
                    "created_at",
                ],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        rows = []

    all_rows_for_counts = rows
    if status:
        all_for_counts = await async_directus.get_items(
            "workspace_request",
            {
                "query": {
                    "fields": ["status"],
                    "limit": -1,
                }
            },
        )
        if isinstance(all_for_counts, list):
            all_rows_for_counts = all_for_counts

    counts = {"pending": 0, "approved": 0, "denied": 0}
    for r in all_rows_for_counts:
        s = r.get("status", "pending")
        if s in counts:
            counts[s] += 1

    enriched = await _enrich_workspace_requests(rows)

    return WorkspaceRequestListResponse(items=enriched, counts=counts)


async def _resolve_requester_info(app_user_id: str) -> tuple[str, str]:
    """Return (display_name, email) for an app_user. Best-effort."""
    try:
        u = await async_directus.get_item("app_user", app_user_id)
        if u:
            return (u.get("display_name") or ""), (u.get("email") or "")
    except Exception:  # noqa: BLE001
        pass
    return ("", "")


async def _notify_requester_approved(
    req: dict,
    granted_tier: str,
    resulting_ws_id: str,
    *,
    workspace_name: Optional[str] = None,
    approved_billing_period: Optional[str] = None,
    proposed_billing_period: Optional[str] = None,
) -> None:
    """In-app notification + email to the requester on approval.

    Cadence appears in subject + body when applicable (pioneer+); for pilot
    approvals it's omitted entirely. When the approved cadence diverges
    from what the requester proposed, the email body adds an explanatory
    line so the customer can object before invoicing.
    """
    requester_id = req.get("requested_by")
    if not requester_id:
        return

    kind_label = "new workspace" if req.get("kind") == "new_workspace" else "tier upgrade"
    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    workspace_url = f"{base}/w/{resulting_ws_id}" if base else f"/w/{resulting_ws_id}"

    ws_name = workspace_name or req.get("proposed_name") or "your workspace"

    cadence_label = f"{approved_billing_period} billing" if approved_billing_period else None

    notification_message = (
        f"{ws_name} \u00b7 {granted_tier} \u00b7 {cadence_label}"
        if cadence_label
        else f"{ws_name} \u00b7 {granted_tier}"
    )

    await emit(
        audience_user_id=requester_id,
        event_code="WORKSPACE_REQUEST_APPROVED",
        title=f"Your {kind_label} request was approved",
        message=notification_message,
        action="NAVIGATE_WS",
        ref_workspace_id=resulting_ws_id,
    )

    _, email = await _resolve_requester_info(requester_id)
    if email:
        if cadence_label:
            subject = f"Your {granted_tier.title()} tier ({cadence_label}) is ready"
        else:
            subject = f"Your {granted_tier.title()} is ready"
        cadence_diverges = (
            approved_billing_period is not None
            and proposed_billing_period is not None
            and approved_billing_period != proposed_billing_period
        )
        await send_email(
            to=email,
            subject=subject,
            template="workspace_request_approved",
            template_data={
                "kind_label": kind_label,
                "workspace_name": ws_name,
                "granted_tier": granted_tier,
                "approved_billing_period": approved_billing_period,
                "proposed_billing_period": proposed_billing_period,
                "cadence_diverges": cadence_diverges,
                "workspace_url": workspace_url,
            },
        )


async def _notify_requester_denied(
    req: dict,
    denial_reason: str,
) -> None:
    """In-app notification + email to the requester on denial."""
    requester_id = req.get("requested_by")
    if not requester_id:
        return

    kind_label = "new workspace" if req.get("kind") == "new_workspace" else "tier upgrade"

    await emit(
        audience_user_id=requester_id,
        event_code="WORKSPACE_REQUEST_DENIED",
        title=f"Your {kind_label} request was not approved",
        message=denial_reason[:200] if denial_reason else None,
        ref_org_id=req.get("org_id"),
        ref_workspace_id=req.get("workspace_id"),
    )

    _, email = await _resolve_requester_info(requester_id)
    if email:
        await send_email(
            to=email,
            subject=f"Your {kind_label} request was not approved",
            template="workspace_request_denied",
            template_data={
                "kind_label": kind_label,
                "denial_reason": denial_reason,
            },
        )


# ── Workspace request actions (approve / deny) ──


class DecideWorkspaceRequestBody(BaseModel):
    action: Literal["approve", "deny"]
    denial_reason: Optional[str] = Field(default=None, max_length=2000)
    granted_tier: Optional[str] = None
    granted_tier_expires_at: Optional[datetime] = None
    granted_type_discount: Optional[Literal["scholarship", "staff_discount"]] = None
    granted_percent_discount: Optional[int] = Field(default=None, ge=0, le=100)
    # Cadence staff actually granted. Pioneer+ should carry annual or monthly;
    # pilot/free must be null. We never mutate proposed_billing_period here —
    # the divergence between the two columns is the audit trail.
    approved_billing_period: Optional[Literal["annual", "monthly"]] = None
    staff_notes: Optional[str] = Field(default=None, max_length=2000)


class DecideWorkspaceRequestResponse(BaseModel):
    id: str
    status: str
    resulting_workspace_id: Optional[str] = None


async def _create_workspace_for_request(
    req: dict,
    granted_tier: str,
    staff_user_id: str,
    granted_tier_expires_at: Optional[str] = None,
    granted_type_discount: Optional[str] = None,
    granted_percent_discount: Optional[int] = None,
) -> str:
    """Create a workspace as part of approving a new_workspace request.

    Uses the same pattern as POST /v2/workspaces but bypasses user-facing
    auth — the caller is already verified as staff.
    """
    from dembrane.utils import generate_uuid
    from dembrane.inheritance import on_workspace_created

    visibility = req.get("proposed_visibility") or "open_to_organisation"
    ws_id = generate_uuid()
    ws_data: dict = {
        "id": ws_id,
        "org_id": req["org_id"],
        "name": (req.get("proposed_name") or "Untitled").strip(),
        "tier": granted_tier,
        "visibility": visibility,
        "is_default": False,
        "created_by": req["requested_by"],
    }
    if granted_tier_expires_at:
        ws_data["tier_expires_at"] = granted_tier_expires_at
    if granted_type_discount:
        ws_data["type_discount"] = granted_type_discount
    if granted_percent_discount is not None:
        ws_data["percent_discount"] = granted_percent_discount

    # Every workspace resolves to exactly one billing account (NOT NULL).
    # Create the account first (its workspace_id FK is set after insert).
    from dembrane.billing_account import (
        link_account_to_workspace,
        create_workspace_scoped_account,
    )

    account_id = await create_workspace_scoped_account(
        tier=granted_tier,
        tier_expires_at=granted_tier_expires_at,
        type_discount=granted_type_discount,
        percent_discount=granted_percent_discount,
        created_by=req["requested_by"],
        label=f"{ws_data['name']} billing",
    )
    ws_data["billing_account_id"] = account_id

    await async_directus.create_item("workspace", ws_data)
    await link_account_to_workspace(account_id, ws_id)
    await on_workspace_created(
        workspace_id=ws_id,
        creator_app_user_id=req["requested_by"],
    )

    logger.info(
        "workspace_request_approved: created workspace %s tier=%s for request %s by staff %s",
        ws_id,
        granted_tier,
        req["id"],
        staff_user_id,
    )
    return ws_id


async def _upgrade_workspace_for_request(
    req: dict,
    granted_tier: str,
    staff_user_id: str,
    granted_tier_expires_at: Optional[str] = None,
    granted_type_discount: Optional[str] = None,
    granted_percent_discount: Optional[int] = None,
) -> tuple[str, str]:
    """Update an existing workspace's tier as part of approving a tier_upgrade request.

    Reuses the tier-change logic from set_workspace_tier. Returns
    (workspace_id, workspace_name) so callers can skip a re-fetch.
    """
    from dembrane.policies import TIER_ORDER
    from dembrane.tier_downgrade import apply_downgrade_effects
    from dembrane.billing_account import resolve_workspace_tier, update_workspace_billing

    workspace_id = req["workspace_id"]
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Target workspace not found")

    from_tier = (await resolve_workspace_tier(workspace_id)) or "pioneer"
    to_tier = granted_tier

    try:
        from_idx = TIER_ORDER.index(from_tier)
        to_idx = TIER_ORDER.index(to_tier)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Unknown tier value") from exc

    direction: Literal["upgrade", "downgrade", "no-change"]
    if from_idx == to_idx:
        direction = "no-change"
    elif to_idx > from_idx:
        direction = "upgrade"
    else:
        direction = "downgrade"

    _effects: list[dict] = []
    if direction == "downgrade":
        _effects = await apply_downgrade_effects(workspace_id, from_tier, to_tier)

    now_iso = datetime.now(timezone.utc).isoformat()
    account_update: dict = {"tier": to_tier}
    if direction == "downgrade":
        account_update["downgraded_at"] = now_iso
        account_update["downgraded_from_tier"] = from_tier
    elif direction == "upgrade":
        account_update["downgraded_at"] = None
        account_update["downgraded_from_tier"] = None
    if granted_tier_expires_at:
        account_update["tier_expires_at"] = granted_tier_expires_at
        account_update["pre_warning_sent"] = False
    if granted_type_discount:
        account_update["type_discount"] = granted_type_discount
    if granted_percent_discount is not None:
        account_update["percent_discount"] = granted_percent_discount

    await update_workspace_billing(workspace_id, account_update)

    if direction == "upgrade":
        from dembrane.tier_downgrade import recalculate_over_cap_on_upgrade

        await recalculate_over_cap_on_upgrade(workspace_id, to_tier)

    if direction != "no-change":
        from dembrane.cache_utils import invalidate_org_usage, invalidate_workspace_usage

        await invalidate_workspace_usage(workspace_id)
        ws_org_id = workspace.get("org_id")
        if ws_org_id:
            await invalidate_org_usage(ws_org_id)

    logger.info(
        "workspace_request_approved: tier change %s %s→%s for request %s by staff %s",
        workspace_id,
        from_tier,
        to_tier,
        req["id"],
        staff_user_id,
    )
    return workspace_id, workspace.get("name") or ""


@router.patch(
    "/workspace-requests/{request_id}",
    response_model=DecideWorkspaceRequestResponse,
)
async def decide_workspace_request(
    request_id: str,
    body: DecideWorkspaceRequestBody,
    auth: DependencyDirectusSession,
    background_tasks: BackgroundTasks,
) -> DecideWorkspaceRequestResponse:
    """Staff approve or deny a workspace request.

    - approve + new_workspace: creates the workspace, assigns requester as owner.
    - approve + tier_upgrade: changes the target workspace's tier.
    - deny: records the denial reason; no workspace changes.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    from dembrane.app_user import get_app_user_or_raise

    staff_user = await get_app_user_or_raise(auth.user_id)
    staff_user_id = staff_user["id"]

    req = await async_directus.get_item("workspace_request", request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Workspace request not found")

    if req.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Request already decided (status={req.get('status')})",
        )

    now_iso = datetime.now(timezone.utc).isoformat()

    # Optimistic lock: atomically claim the request by setting status +
    # decided_by while filtering on status=pending. If another staff member
    # already claimed it, the update matches 0 rows and we bail with 409.
    claim_payload: dict = {
        "decided_at": now_iso,
        "decided_by": staff_user_id,
    }
    if body.staff_notes:
        claim_payload["staff_notes"] = body.staff_notes

    if body.action == "approve":
        claim_payload["status"] = "approved"
    else:
        if not body.denial_reason or not body.denial_reason.strip():
            raise HTTPException(status_code=400, detail="denial_reason is required")
        claim_payload["status"] = "denied"
        claim_payload["denial_reason"] = body.denial_reason.strip()

    # Directus update_item doesn't support conditional filters, so we
    # re-read after the write to detect a concurrent decision.
    await async_directus.update_item("workspace_request", request_id, claim_payload)
    refreshed = await async_directus.get_item("workspace_request", request_id)
    if refreshed and refreshed.get("decided_by") != staff_user_id:
        raise HTTPException(
            status_code=409,
            detail="Request was decided by another staff member concurrently",
        )

    if body.action == "approve":
        granted_tier = body.granted_tier or req.get("proposed_tier", "innovator")
        from dembrane.policies import TIER_ORDER

        if granted_tier not in TIER_ORDER:
            raise HTTPException(status_code=400, detail=f"Unknown tier: {granted_tier}")

        # Cadence vs tier validity. Pioneer+ must have a cadence (approve form
        # is server-side validated, not just UI-validated); pilot/free strip
        # the cadence to null regardless of what the toggle was last on.
        _cadence_tiers = {"pioneer", "innovator", "changemaker", "guardian"}
        if granted_tier in _cadence_tiers and body.approved_billing_period is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"approved_billing_period is required for {granted_tier} (annual or monthly)"
                ),
            )
        approved_billing_period: Optional[str] = (
            body.approved_billing_period if granted_tier in _cadence_tiers else None
        )

        expires_iso = (
            body.granted_tier_expires_at.isoformat() if body.granted_tier_expires_at else None
        )

        resulting_ws_id: str
        resulting_ws_name: str = ""
        if req.get("kind") == "new_workspace":
            resulting_ws_id = await _create_workspace_for_request(
                req,
                granted_tier=granted_tier,
                staff_user_id=staff_user_id,
                granted_tier_expires_at=expires_iso,
                granted_type_discount=body.granted_type_discount,
                granted_percent_discount=body.granted_percent_discount,
            )
            # We just created it with this name — no need to re-fetch.
            resulting_ws_name = (req.get("proposed_name") or "").strip()
        elif req.get("kind") == "tier_upgrade":
            if not req.get("workspace_id"):
                raise HTTPException(
                    status_code=400,
                    detail="tier_upgrade request missing workspace_id",
                )
            resulting_ws_id, resulting_ws_name = await _upgrade_workspace_for_request(
                req,
                granted_tier=granted_tier,
                staff_user_id=staff_user_id,
                granted_tier_expires_at=expires_iso,
                granted_type_discount=body.granted_type_discount,
                granted_percent_discount=body.granted_percent_discount,
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown kind: {req.get('kind')}")

        extra_data: dict = {
            "granted_tier": granted_tier,
            "resulting_workspace_id": resulting_ws_id,
            # proposed_billing_period is NEVER overwritten here — divergence
            # between proposed/approved is the audit trail.
            "approved_billing_period": approved_billing_period,
        }
        if expires_iso:
            extra_data["granted_tier_expires_at"] = expires_iso
        if body.granted_type_discount:
            extra_data["granted_type_discount"] = body.granted_type_discount
        if body.granted_percent_discount is not None:
            extra_data["granted_percent_discount"] = body.granted_percent_discount

        await async_directus.update_item("workspace_request", request_id, extra_data)

        # Off the request path: SendGrid alone adds ~300–1000ms.
        background_tasks.add_task(
            _notify_requester_approved,
            req,
            granted_tier,
            resulting_ws_id,
            workspace_name=resulting_ws_name,
            approved_billing_period=approved_billing_period,
            proposed_billing_period=req.get("proposed_billing_period"),
        )

        return DecideWorkspaceRequestResponse(
            id=request_id,
            status="approved",
            resulting_workspace_id=resulting_ws_id,
        )

    # action == "deny"
    await async_directus.update_item("workspace_request", request_id, {})

    logger.info(
        "workspace_request_denied: request %s by staff %s",
        request_id,
        staff_user_id,
    )

    background_tasks.add_task(
        _notify_requester_denied,
        req,
        (body.denial_reason or "").strip(),
    )

    return DecideWorkspaceRequestResponse(
        id=request_id,
        status="denied",
    )


# ── Staff workspace discount edit ──


class UpdateWorkspaceDiscountBody(BaseModel):
    type_discount: Optional[Literal["scholarship", "staff_discount"]] = Field(
        default=None, description="Set to null to clear."
    )
    percent_discount: Optional[int] = Field(
        default=None, ge=0, le=100, description="0-100 or null to clear."
    )
    clear_type_discount: bool = Field(
        default=False, description="When true, sets type_discount to null."
    )
    clear_percent_discount: bool = Field(
        default=False, description="When true, sets percent_discount to null."
    )


@router.patch("/workspaces/{workspace_id}/discount")
async def update_workspace_discount(
    workspace_id: str,
    body: UpdateWorkspaceDiscountBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: edit type_discount / percent_discount on a workspace.

    These fields are descriptive metadata for finance; no code path
    multiplies a price by (1 - percent_discount/100).
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    payload: dict = {}
    if body.clear_type_discount:
        payload["type_discount"] = None
    elif body.type_discount is not None:
        payload["type_discount"] = body.type_discount

    if body.clear_percent_discount:
        payload["percent_discount"] = None
    elif body.percent_discount is not None:
        payload["percent_discount"] = body.percent_discount

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("workspace", workspace_id, payload)
    logger.info(
        "staff discount update on workspace %s: %s by staff %s",
        workspace_id,
        payload,
        auth.user_id,
    )
    return {"status": "ok", **payload}


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
            out.append(
                AtRiskRow(
                    workspace_id=r.workspace_id,
                    workspace_name=r.workspace_name,
                    org_id=r.org_id,
                    org_name=r.org_name,
                    tier=r.tier,
                    reason="pilot_hard_block",
                    detail=f"Pilot hit {r.audio_hours:.1f}h of {r.audio_hours_included}h — host-side blocked",
                )
            )
            continue
        if r.at_cap:
            out.append(
                AtRiskRow(
                    workspace_id=r.workspace_id,
                    workspace_name=r.workspace_name,
                    org_id=r.org_id,
                    org_name=r.org_name,
                    tier=r.tier,
                    reason="at_cap",
                    detail=f"{r.audio_hours:.1f}h / {r.audio_hours_included}h — {r.hour_overage_eur:.0f} EUR overage",
                )
            )
            continue
        if r.approaching_cap:
            out.append(
                AtRiskRow(
                    workspace_id=r.workspace_id,
                    workspace_name=r.workspace_name,
                    org_id=r.org_id,
                    org_name=r.org_name,
                    tier=r.tier,
                    reason="approaching_cap",
                    detail=f"{r.audio_hours:.1f}h / {r.audio_hours_included}h ({(r.hours_pct or 0) * 100:.0f}%)",
                )
            )
        if r.downgraded_at:
            # Only surface if within 14 days
            try:
                dt = datetime.fromisoformat(r.downgraded_at.replace("Z", "+00:00"))
                if (now - dt).days <= 14:
                    out.append(
                        AtRiskRow(
                            workspace_id=r.workspace_id,
                            workspace_name=r.workspace_name,
                            org_id=r.org_id,
                            org_name=r.org_name,
                            tier=r.tier,
                            reason="recently_downgraded",
                            detail=f"Downgraded {dt.strftime('%Y-%m-%d')} from {r.downgraded_from_tier}",
                        )
                    )
            except Exception:
                pass
    return out
