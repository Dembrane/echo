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

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane import mollie
from dembrane.settings import get_settings
from dembrane.seat_capacity import compute_effective_seat_state
from dembrane.tier_capacity import get_capacity
from dembrane.billing_service import (
    BillingError,
    apply_discount,
    count_account_seats,
    _per_interval_amount,
)
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
    billing_account_id: Optional[str] = None
    # Scope of the owning billing account: "organisation" (org-scoped, the org
    # is the payer and may pool many workspaces) or "workspace" (billed on its
    # own). Drives the "Organisation account" / "Workspace account" label.
    account_scope: Optional[Literal["organisation", "workspace"]] = None
    tier: str
    is_partner_owned: bool = False
    # Staff-set org partner flag (org.is_partner). Gates the workspace
    # internal-vs-client self-identify branch. Editable from the staff
    # dashboard (Founder decision D1). Distinct from `is_partner_owned`,
    # which is derived from billing handoff state.
    org_is_partner: bool = False
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


class AccountRow(BaseModel):
    """One row = one billing account (the paying entity).

    An org-scoped account pools every workspace in the org; a workspace-scoped
    account is a single workspace. Seats (members + external) and forecast are
    aggregated across the account's workspaces. Per-workspace detail stays in
    `workspaces` for drill-down.
    """

    billing_account_id: str
    # Human label: account.label, else the org / workspace name.
    label: str
    # "organisation" (org-scoped, pools workspaces) or "workspace" (single).
    account_scope: Optional[Literal["organisation", "workspace"]] = None
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    # Tier lives on the account, so change-tier acts here (not per workspace).
    tier: str
    # Account counts.
    workspace_count: int = 0
    active_workspace_count: int = 0
    # Pooled seats across the account's workspaces.
    seat_count: int = 0
    external_count: int = 0
    # Forecast = tier base, charged once per account (not per workspace).
    # €0 for trial / comped accounts so they never inflate revenue.
    base_price_eur: Optional[float] = None
    total_forecast_eur: float = 0.0
    # Revenue classification.
    is_trial: bool = False
    is_managed: bool = False
    # Comped = does not contribute to MRR (trial, or a free/comped tier with no
    # paying payment_mode). Surfaced as a separate count, never in the total.
    is_comped: bool = False
    # An account is active when any of its workspaces is active.
    is_active: bool = True
    tier_expires_at: Optional[str] = None
    type_discount: Optional[str] = None
    percent_discount: Optional[int] = None
    payment_mode: Optional[str] = None
    # Per-workspace drill-down: the workspace-scoped kebab actions act on these.
    workspaces: list[BillingRow] = []


class BillingRollupResponse(BaseModel):
    cycle_start: str
    cycle_end_exclusive: str
    workspace_count: int
    active_workspace_count: int
    # Account counts (the pivot unit). account_count = len(accounts).
    account_count: int = 0
    active_account_count: int = 0
    # Trial + managed + comped subtotals, kept separate from paying revenue.
    trial_account_count: int = 0
    managed_account_count: int = 0
    comped_account_count: int = 0
    total_base_eur: float
    total_overage_eur: float
    # Paying revenue only: trial + comped accounts contribute €0 here. A granted
    # trial therefore never raises this total.
    total_forecast_eur: float
    # MRR = sum of (paying account base prices) for non-pilot tiers. Trials and
    # comped accounts are excluded.
    mrr_eur: float
    # Count of workspace admins (non-external, admin+owner) who logged
    # in in the last 30 days. Proxy for "active accounts you can
    # reach" since we don't have a full DAU pipeline.
    logins_last_30d: int
    # Account-primary rows (the dashboard pivot).
    accounts: list[AccountRow] = []
    # Per-workspace rows, retained for CSV export + backward compatibility.
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
                    # JSON column; staff "reset monthly usage" stamps
                    # settings.usage_reset_at here as a per-cycle floor.
                    "settings",
                    # Request the account id explicitly. Asking for nested
                    # fields (billing_account_id.tier, ...) makes Directus
                    # return billing_account_id as a joined object, so a bare
                    # "billing_account_id" entry would come back as that dict,
                    # not the scalar id BillingRow expects.
                    "billing_account_id.id",
                    # Scope discriminator: an org-scoped account carries org_id;
                    # a workspace-scoped account carries workspace_id instead.
                    "billing_account_id.org_id",
                    "billing_account_id.workspace_id",
                    # Revenue classification: payment_mode ("mollie" paying /
                    # "offline" managed / "none" comped) + the account label.
                    "billing_account_id.payment_mode",
                    "billing_account_id.label",
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
    # read ws["tier"], ws["downgraded_at"], etc. unchanged, then collapse
    # billing_account_id back to the scalar account id (it arrives as the
    # joined object because we requested nested fields on it).
    for ws in out:
        account = ws.get("billing_account_id")
        ws.update(billing_from_workspace(ws))
        if isinstance(account, dict):
            ws["billing_account_id"] = account.get("id")
            # Org-scoped accounts carry org_id; workspace-scoped ones carry
            # workspace_id. org_id wins when both are present (shared account).
            ws["account_scope"] = (
                "organisation" if account.get("org_id") else "workspace"
            )
            # Account-level revenue classification, carried to the aggregator.
            ws["account_payment_mode"] = account.get("payment_mode")
            ws["account_label"] = account.get("label")
        else:
            ws["billing_account_id"] = account
            ws["account_scope"] = None
            ws["account_payment_mode"] = None
            ws["account_label"] = None
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


async def _org_partner_map(org_ids: list[str]) -> dict[str, bool]:
    """Map org_id → is_partner for the staff billing rollup."""
    if not org_ids:
        return {}
    rows = await async_directus.get_items(
        "org",
        {
            "query": {
                "filter": {"id": {"_in": list(set(org_ids))}},
                "fields": ["id", "is_partner"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return {}
    return {r["id"]: bool(r.get("is_partner")) for r in rows}


async def _workspace_hours_this_cycle(
    ws_id: str,
    cycle_start: str,
    cycle_end: str,
    reset_at: Optional[str] = None,
) -> float:
    """Sum conversation.duration (seconds) → hours for this workspace's
    projects in the current cycle.

    `reset_at` (workspace.settings.usage_reset_at) acts as a per-cycle floor:
    a staff "reset monthly usage" stamps it, and we then only count
    conversations created at/after it. It only applies when it falls inside
    the displayed cycle, so past months and later cycles are unaffected.
    """
    effective_start = cycle_start
    if reset_at and cycle_start <= reset_at < cycle_end:
        effective_start = reset_at
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
                    "created_at": {"_gte": effective_start, "_lt": cycle_end},
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


def _is_trial_account(
    *,
    type_discount: Optional[str],
    payment_mode: Optional[str],
    tier: Optional[str],
    tier_expires_at: Optional[str],
    now_iso: str,
) -> bool:
    """A reverse trial: explicitly flagged `type_discount="trial"`, or the
    grant_reverse_trial shape (comped `payment_mode="none"` on a real tier with
    a future expiry)."""
    if type_discount == "trial":
        return True
    if (
        payment_mode == "none"
        and tier
        and tier != "free"
        and tier_expires_at
        and tier_expires_at > now_iso
    ):
        return True
    return False


def _account_monthly_forecast(
    tier: str, seats: int, billing_period: Optional[str], percent_discount: Optional[int]
) -> float:
    """Discounted monthly revenue for a paying account under the per-seat model:
    `seats × per-seat price × (1 - discount)`, normalised to a monthly figure.

    Reuses `billing_service._per_interval_amount` (the same seats × per-seat math
    the real Mollie charge + customer overview use) so the staff forecast matches
    what the account is actually billed. Annual cadence bills 12 months at once,
    so its interval amount is divided by 12 to land on the monthly headline the
    rollup reports. Free / unpriced tiers (no per-seat rate) forecast €0.
    """
    period = billing_period or "annual"
    try:
        amount, _interval = _per_interval_amount(tier, max(seats, 1), period)
    except BillingError:
        return 0.0
    monthly = amount / 12 if period == "annual" else amount
    return apply_discount(monthly, percent_discount)


def _aggregate_accounts(
    rows: list[BillingRow],
    *,
    org_name_by_id: dict[str, str],
    label_by_account: dict[str, Optional[str]],
    payment_mode_by_account: dict[str, Optional[str]],
    now_iso: str,
    pooled_seats_by_account: Optional[dict[str, int]] = None,
) -> list[AccountRow]:
    """Collapse per-workspace BillingRows into one AccountRow per billing
    account. Org-scoped accounts pool every workspace; workspace-scoped accounts
    carry exactly one. Seats sum across the account's workspaces; the tier base
    is charged once per account.

    Trial / comped accounts contribute €0 to total_forecast_eur so granting a
    trial never inflates paying revenue; managed (offline) accounts are billed
    and so do count.
    """
    by_account: dict[str, list[BillingRow]] = {}
    order: list[str] = []
    for r in rows:
        # Workspaces with no resolvable account (legacy / unjoined) can't be
        # billed as an account; skip them from the account pivot. They remain in
        # the per-workspace `rows` for visibility.
        acc_id = r.billing_account_id
        if not acc_id:
            continue
        if acc_id not in by_account:
            by_account[acc_id] = []
            order.append(acc_id)
        by_account[acc_id].append(r)

    accounts: list[AccountRow] = []
    for acc_id in order:
        members = by_account[acc_id]
        first = members[0]
        tier = first.tier
        payment_mode = payment_mode_by_account.get(acc_id)
        label = label_by_account.get(acc_id) or (
            first.org_name if first.account_scope == "organisation" else first.workspace_name
        )
        base_price = TIER_BASE_PRICE_EUR.get(tier)

        is_trial = _is_trial_account(
            type_discount=first.type_discount,
            payment_mode=payment_mode,
            tier=tier,
            tier_expires_at=first.tier_expires_at,
            now_iso=now_iso,
        )
        is_managed = payment_mode == "offline"
        # Comped = no real payment relationship behind a paid tier: a trial, or a
        # paid tier sitting on payment_mode="none" (a hand-granted comp). Managed
        # (offline) and mollie are real revenue. Free tier has no base, so it is
        # never counted regardless.
        is_comped = is_trial or (
            payment_mode not in ("mollie", "offline")
            and base_price is not None
        )

        active_count = sum(1 for m in members if m.is_active)
        # Pooled billable seats (members + externals, who share the one seat
        # pool). Prefer the deduped account-level count when supplied: summing
        # each workspace's seat_count double-counts a user who belongs to more
        # than one pooled workspace. Fall back to the per-workspace sum when no
        # pooled map is given (single-workspace accounts can't double-count).
        member_seats = sum(m.seat_count for m in members)
        external_seats = sum(m.external_count for m in members)
        billable_seats = (
            pooled_seats_by_account.get(acc_id)
            if pooled_seats_by_account is not None
            else None
        )
        if billable_seats is None:
            billable_seats = member_seats + external_seats
        # Forecast: per-seat model = seats × per-seat price × (1 - discount),
        # charged per account (not per workspace), €0 when comped/trial. Matches
        # the (discounted) amount the customer is actually billed via Mollie.
        # Comped/trial stay €0.
        forecast = (
            0.0
            if is_comped
            else _account_monthly_forecast(
                tier, billable_seats, first.billing_period, first.percent_discount
            )
        )

        accounts.append(
            AccountRow(
                billing_account_id=acc_id,
                label=label or "",
                account_scope=first.account_scope,
                org_id=first.org_id or None,
                org_name=org_name_by_id.get(first.org_id or "") or first.org_name or None,
                tier=tier,
                workspace_count=len(members),
                active_workspace_count=active_count,
                seat_count=sum(m.seat_count for m in members),
                external_count=sum(m.external_count for m in members),
                base_price_eur=base_price,
                total_forecast_eur=round(forecast, 2),
                is_trial=is_trial,
                is_managed=is_managed,
                is_comped=is_comped,
                is_active=active_count > 0,
                tier_expires_at=first.tier_expires_at,
                type_discount=first.type_discount,
                percent_discount=first.percent_discount,
                payment_mode=payment_mode,
                workspaces=members,
            )
        )

    # Comped/trial last, then paying accounts by forecast desc so revenue floats
    # to the top and the comped block reads as a clearly separate tail.
    accounts.sort(key=lambda a: (a.is_comped, -a.total_forecast_eur))
    return accounts


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
    org_partner_by_id = await _org_partner_map(org_ids)

    rows: list[BillingRow] = []
    total_base = 0.0
    total_overage = 0.0
    # Account-level metadata captured during the workspace loop, keyed by
    # account id, for the account aggregation below.
    label_by_account: dict[str, Optional[str]] = {}
    payment_mode_by_account: dict[str, Optional[str]] = {}

    for ws in workspaces:
        ws_id = ws["id"]
        tier = ws.get("tier", "pioneer")
        cap = get_capacity(tier)
        reset_at = (ws.get("settings") or {}).get("usage_reset_at")
        hours = await _workspace_hours_this_cycle(
            ws_id, cycle_start, cycle_end, reset_at=reset_at
        )
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
        # Per-seat rework removed seat/hour overage, so the monthly forecast is
        # just the tier base. (Discount is applied separately in Wave A.)
        total = base_price

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
            billing_account_id=ws.get("billing_account_id"),
            account_scope=ws.get("account_scope"),
            tier=tier,
            is_partner_owned=is_partner,
            org_is_partner=org_partner_by_id.get(ws.get("org_id", ""), False),
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
            billing_period=ws.get("billing_period"),
        )
        rows.append(row)
        acc_id = ws.get("billing_account_id")
        if acc_id:
            label_by_account[acc_id] = ws.get("account_label")
            payment_mode_by_account[acc_id] = ws.get("account_payment_mode")
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

    # Pooled billable seats per account: distinct users across the account's
    # workspaces (members + externals share one pool), deduped so a user in two
    # pooled workspaces is one seat, not two. This is the canonical seat count
    # the per-seat forecast multiplies by, matching count_account_seats.
    pooled_seats_by_account: dict[str, int] = {}
    for acc_id in {r.billing_account_id for r in rows if r.billing_account_id}:
        try:
            pooled_seats_by_account[acc_id] = await count_account_seats(acc_id)
        except Exception:  # noqa: BLE001 - never let one account break the rollup
            logger.exception("pooled seat count failed for account %s", acc_id)

    # Pivot to the billing account: one row per account, seats pooled across its
    # workspaces, forecast = seats × per-seat × (1 - discount). Trials + comped
    # contribute €0.
    now_iso = datetime.now(timezone.utc).isoformat()
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id=org_name_by_id,
        label_by_account=label_by_account,
        payment_mode_by_account=payment_mode_by_account,
        now_iso=now_iso,
        pooled_seats_by_account=pooled_seats_by_account,
    )

    # Paying revenue only: comped/trial accounts add €0 (forecast already
    # zeroed). MRR = the recurring (non-pilot) per-seat revenue of paying
    # accounts, identical to each account's discounted monthly forecast.
    total_forecast = sum(a.total_forecast_eur for a in accounts)
    mrr = 0.0
    for a in accounts:
        if not a.is_comped and a.tier != "pilot":
            mrr += a.total_forecast_eur

    active_count = sum(1 for r in rows if r.is_active)
    active_account_count = sum(1 for a in accounts if a.is_active)
    trial_account_count = sum(1 for a in accounts if a.is_trial)
    managed_account_count = sum(1 for a in accounts if a.is_managed)
    comped_account_count = sum(1 for a in accounts if a.is_comped)

    # Last 30 days of calendar time, not the selected period.
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    logins_30d = await _recent_login_count(since)

    return BillingRollupResponse(
        cycle_start=cycle_start,
        cycle_end_exclusive=cycle_end,
        workspace_count=len(rows),
        active_workspace_count=active_count,
        account_count=len(accounts),
        active_account_count=active_account_count,
        trial_account_count=trial_account_count,
        managed_account_count=managed_account_count,
        comped_account_count=comped_account_count,
        total_base_eur=round(total_base, 2),
        total_overage_eur=round(total_overage, 2),
        # Paying revenue: comped/trial accounts excluded, so a granted trial
        # never raises this total.
        total_forecast_eur=round(total_forecast, 2),
        mrr_eur=round(mrr, 2),
        logins_last_30d=logins_30d,
        accounts=accounts,
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

    `percent_discount` is applied as `amount × (1 - percent_discount/100)`
    everywhere a price is shown or charged: the live Mollie subscription amount,
    prorated seat charges, the customer billing overview / estimate, and the
    admin forecast + MRR (see `billing_service.apply_discount`). `type_discount`
    is the descriptive reason tag (scholarship / staff_discount / trial).
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


@router.patch("/billing-accounts/{account_id}/discount")
async def update_billing_account_discount(
    account_id: str,
    body: UpdateWorkspaceDiscountBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: edit type_discount / percent_discount on a billing account.

    The billing account is the canonical home of the discount: `percent_discount`
    reduces every price the account is charged or shown (live Mollie subscription
    amount, prorated seat charges, customer overview, and the admin forecast +
    MRR, see `billing_service.apply_discount`), and `type_discount` is the
    descriptive reason tag (scholarship / staff_discount / trial). Writing the
    workspace row instead would let the workspace- and account-level values
    diverge, so the staff editor targets the account. Idempotent.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")

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

    updated = (await async_directus.update_item("billing_account", account_id, payload))[
        "data"
    ]
    logger.info(
        "staff discount update on billing account %s: %s by staff %s",
        account_id,
        payload,
        auth.user_id,
    )
    return {"status": "ok", **payload, "account_id": updated.get("id", account_id)}


class UpdateOrgPartnerBody(BaseModel):
    is_partner: bool = Field(
        description="Staff-set org partner flag. Gates the workspace "
        "internal-vs-client self-identify branch (Founder decision D1)."
    )


@router.patch("/orgs/{org_id}/partner")
async def update_org_partner(
    org_id: str,
    body: UpdateOrgPartnerBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: toggle org.is_partner.

    A partner org's workspaces self-identify internal vs external client use
    on creation. No secret code (Founder decision D1), this flag is the
    whole gate.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    org = await async_directus.get_item("org", org_id)
    if not org or org.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Organisation not found")

    await async_directus.update_item("org", org_id, {"is_partner": body.is_partner})
    logger.info(
        "staff set org %s is_partner=%s by staff %s",
        org_id,
        body.is_partner,
        auth.user_id,
    )
    return {"status": "ok", "org_id": org_id, "is_partner": body.is_partner}


class GrantTrialBody(BaseModel):
    tier: Literal["innovator", "changemaker", "guardian"] = Field(
        default="changemaker", description="Tier to grant for the trial."
    )
    months: int = Field(default=1, ge=1, le=12, description="Trial length in months.")


@router.post("/billing-accounts/{account_id}/grant-trial")
async def grant_account_trial(
    account_id: str,
    body: GrantTrialBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: grant a comped reverse trial on a billing account.

    Keyed on the billing account (the real unit) — a partner org can hold many
    accounts (one per client), so account-id, not org-id. The account gets
    `tier` for `months` (default Changemaker, 1 month), comped (no Mollie). The
    expiry cron auto-reverts it to Free; the pre-warning cron nudges 3 days
    before. This is the staff-dashboard "load a trial" action.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    from dembrane.cache_utils import invalidate_org_usage
    from dembrane.billing_account import grant_reverse_trial

    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")

    expires_at = await grant_reverse_trial(account_id, tier=body.tier, months=body.months)
    if account.get("org_id"):
        await invalidate_org_usage(account["org_id"])
    logger.info(
        "staff granted %s trial (%d mo, expires %s) on billing account %s by %s",
        body.tier,
        body.months,
        expires_at,
        account_id,
        auth.user_id,
    )
    return {
        "status": "ok",
        "billing_account_id": account_id,
        "tier": body.tier,
        "tier_expires_at": expires_at,
    }


# ── Staff workspace controls (ISSUE-024 sub-item 6) ──
#
# Safe staff edits wired from the dashboard kebab. "Change tier" reuses the
# existing PATCH /v2/workspaces/{id}/tier (downgrade effects + notifications
# live there); only the two below are new here. transfer-to-partner and
# delete-workspace stay unwired (destructive, deferred to their own issues).


class WorkspaceMemberRow(BaseModel):
    membership_id: str
    user_id: Optional[str] = None
    display_name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None


@router.get(
    "/workspaces/{workspace_id}/members", response_model=list[WorkspaceMemberRow]
)
async def list_workspace_members(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> list[WorkspaceMemberRow]:
    """Staff-only: every non-deleted membership of a workspace, enriched with
    the user's name + email. Feeds the "change workspace admin" picker. Skips
    the workspace-context policy plumbing because staff already cleared the
    is_admin gate."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    mems = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "user_id", "role"],
                "limit": -1,
            }
        },
    )
    if not isinstance(mems, list) or not mems:
        return []
    user_ids = [m["user_id"] for m in mems if m.get("user_id")]
    users_by_id: dict[str, dict] = {}
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
            users_by_id = {u["id"]: u for u in users}
    out: list[WorkspaceMemberRow] = []
    for m in mems:
        u = users_by_id.get(m.get("user_id") or "", {})
        out.append(
            WorkspaceMemberRow(
                membership_id=str(m["id"]),
                user_id=m.get("user_id"),
                display_name=u.get("display_name"),
                email=u.get("email"),
                role=m.get("role"),
            )
        )
    return out


class ChangeWorkspaceAdminBody(BaseModel):
    membership_id: str = Field(
        description="workspace_membership row to promote to admin.",
    )


@router.post("/workspaces/{workspace_id}/change-admin")
async def change_workspace_admin(
    workspace_id: str,
    body: ChangeWorkspaceAdminBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: promote a workspace member to admin.

    Used when the current admin is unreachable. Promotes the named membership
    to "admin"; existing admins keep their role (no demotion, so the workspace
    can never be stranded without an admin). The membership must belong to this
    workspace and not be an external row (ADR-0003 boundary).
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    membership = await async_directus.get_item("workspace_membership", body.membership_id)
    if (
        not membership
        or membership.get("deleted_at")
        or membership.get("workspace_id") != workspace_id
    ):
        raise HTTPException(
            status_code=404, detail="Membership not found in this workspace"
        )
    if membership.get("role") == "external":
        raise HTTPException(
            status_code=400,
            detail="Cannot promote an external member to admin. Add them to the org first.",
        )

    if membership.get("role") not in ("admin", "owner"):
        await async_directus.update_item(
            "workspace_membership", body.membership_id, {"role": "admin"}
        )
    logger.info(
        "staff promoted membership %s to admin on workspace %s by staff %s",
        body.membership_id,
        workspace_id,
        auth.user_id,
    )
    return {
        "status": "ok",
        "workspace_id": workspace_id,
        "membership_id": body.membership_id,
        "role": "admin",
    }


class ResetUsageBody(BaseModel):
    reason: str = Field(
        min_length=1,
        max_length=500,
        description="Internal note for the staff audit trail.",
    )


@router.post("/workspaces/{workspace_id}/reset-usage")
async def reset_workspace_usage(
    workspace_id: str,
    body: ResetUsageBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Staff-only: zero this cycle's recorded audio hours for a workspace.

    Q3 (ISSUE-024) default: stamps `settings.usage_reset_at` to now. The hours
    rollup treats that timestamp as a per-cycle floor, so only conversations
    created after it count toward this month's usage. Conversation rows are NOT
    deleted (audit-preserving). The Directus update on the workspace produces a
    directus_activity row; the reason is logged for the staff audit trail.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    settings = ws.get("settings") or {}
    settings["usage_reset_at"] = now_iso
    settings["usage_reset_by"] = auth.user_id
    settings["usage_reset_reason"] = body.reason
    await async_directus.update_item("workspace", workspace_id, {"settings": settings})

    # Bust cached usage so the new floor takes effect on the next read.
    from dembrane.cache_utils import invalidate_org_usage, invalidate_workspace_usage

    await invalidate_workspace_usage(workspace_id)
    if ws.get("org_id"):
        await invalidate_org_usage(ws["org_id"])

    logger.info(
        "staff reset monthly usage on workspace %s at %s by staff %s, reason=%r",
        workspace_id,
        now_iso,
        auth.user_id,
        body.reason,
    )
    return {
        "status": "ok",
        "workspace_id": workspace_id,
        "usage_reset_at": now_iso,
    }


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

    # Pass month_offset explicitly: called as a plain coroutine (not via
    # FastAPI), the parameter default is the Query() marker, not an int.
    rollup = await billing_rollup(auth, month_offset=0)
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


# ── Payments rollup (Wave B) ──
#
# Read-only surfacing of recent Mollie transactions across every billing
# account. dembrane never auto-blocks a customer for non-payment (Wave B
# decision): staff watch this list and action non-payment by hand, so the
# view also links out to the Mollie dashboard where refunds / chargebacks /
# customer detail live.


# Mollie has no per-organisation dashboard deep link, so we point staff at the
# right environment's payments index. Test and live are separate dashboards.
_MOLLIE_DASHBOARD_LIVE = "https://www.mollie.com/dashboard/payments"
_MOLLIE_DASHBOARD_TEST = "https://www.mollie.com/dashboard/org_test/payments"


class PaymentRow(BaseModel):
    """One Mollie transaction, enriched with the local account it belongs to."""

    payment_id: str
    billing_account_id: Optional[str] = None
    account_label: Optional[str] = None
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    tier: Optional[str] = None
    created_at: Optional[str] = None
    amount: Optional[str] = None
    currency: str = "EUR"
    # Mollie status: open / pending / paid / failed / expired / canceled.
    status: Optional[str] = None
    # first (consent) / recurring / oneoff. Lets staff tell a renewal from a
    # proration charge from the initial checkout.
    sequence_type: Optional[str] = None
    method: Optional[str] = None
    description: str = ""
    # Per-payment Mollie dashboard deep link when available.
    dashboard_url: Optional[str] = None


class PaymentsRollupResponse(BaseModel):
    # Configuration / environment state so the UI can explain an empty list.
    mollie_enabled: bool
    mollie_test_mode: bool
    mollie_dashboard_url: str
    accounts_with_customer: int
    # Headline counters over the returned window.
    payment_count: int
    paid_eur: float
    failed_count: int
    open_count: int
    rows: list[PaymentRow]


def _payment_dashboard_url(payment: dict, *, test_mode: bool) -> Optional[str]:
    """Mollie embeds a dashboard link in `_links.dashboard.href` on each
    payment. Prefer it; fall back to None (the response carries the index URL)."""
    href = (((payment or {}).get("_links") or {}).get("dashboard") or {}).get("href")
    return href or None


@router.get("/payments", response_model=PaymentsRollupResponse)
async def payments_rollup(
    auth: DependencyDirectusSession,
    per_account: int = Query(
        default=10,
        ge=1,
        le=50,
        description="Most-recent payments to pull per billing account.",
    ),
) -> PaymentsRollupResponse:
    """Recent Mollie transactions across every billing account, newest first.

    Aggregates each account's most-recent payments (same list-payments pattern
    as the in-app invoice list, but pooled across accounts) so staff have one
    place to watch for failed / overdue charges. Read-only: nobody is blocked
    from here, this is where staff decide who to chase. The response carries a
    deep link to the Mollie dashboard for refunds and customer detail.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    settings = get_settings()
    test_mode = settings.billing.mollie_test_mode
    dashboard_url = _MOLLIE_DASHBOARD_TEST if test_mode else _MOLLIE_DASHBOARD_LIVE

    accounts = await async_directus.get_items(
        "billing_account",
        {
            "query": {
                "filter": {
                    "deleted_at": {"_null": True},
                    "mollie_customer_id": {"_nnull": True},
                },
                "fields": ["id", "label", "org_id", "tier", "mollie_customer_id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(accounts, list):
        accounts = []

    org_name_by_id = await _org_name_map([a["org_id"] for a in accounts if a.get("org_id")])

    rows: list[PaymentRow] = []
    paid_eur = 0.0
    failed_count = 0
    open_count = 0

    # Mollie isn't configured (local / unset key): return the empty shell with
    # the flags set so the UI can say "connect Mollie" instead of erroring.
    if settings.billing.mollie_enabled:
        for account in accounts:
            customer_id = account.get("mollie_customer_id")
            if not customer_id:
                continue
            try:
                payments = await mollie.list_customer_payments(
                    customer_id, limit=per_account
                )
            except mollie.MollieError as exc:
                # One bad customer must not sink the whole rollup; skip and log.
                logger.warning(
                    "Mollie payments fetch failed for account %s: %s",
                    account.get("id"),
                    exc,
                )
                continue
            for p in payments:
                amt = p.get("amount") or {}
                status = p.get("status")
                value = amt.get("value")
                if status == "paid":
                    try:
                        paid_eur += float(value)
                    except (TypeError, ValueError):
                        pass
                elif status in ("failed", "expired", "canceled"):
                    failed_count += 1
                elif status in ("open", "pending"):
                    open_count += 1
                rows.append(
                    PaymentRow(
                        payment_id=str(p.get("id")),
                        billing_account_id=account.get("id"),
                        account_label=account.get("label"),
                        org_id=account.get("org_id"),
                        org_name=org_name_by_id.get(account.get("org_id") or ""),
                        tier=account.get("tier"),
                        created_at=p.get("createdAt"),
                        amount=value,
                        currency=amt.get("currency") or "EUR",
                        status=status,
                        sequence_type=p.get("sequenceType"),
                        method=p.get("method"),
                        description=p.get("description") or "",
                        dashboard_url=_payment_dashboard_url(p, test_mode=test_mode),
                    )
                )

    # Newest first across all accounts. createdAt is ISO-8601, so string sort
    # is chronological; missing dates sort last.
    rows.sort(key=lambda r: r.created_at or "", reverse=True)

    return PaymentsRollupResponse(
        mollie_enabled=settings.billing.mollie_enabled,
        mollie_test_mode=test_mode,
        mollie_dashboard_url=dashboard_url,
        accounts_with_customer=len([a for a in accounts if a.get("mollie_customer_id")]),
        payment_count=len(rows),
        paid_eur=round(paid_eur, 2),
        failed_count=failed_count,
        open_count=open_count,
        rows=rows,
    )
