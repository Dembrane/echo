"""V2 workspace endpoints — list, create, manage workspaces."""

import asyncio
from datetime import datetime, timezone
from logging import getLogger
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user, get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.email import send_email
from dembrane.policies import TIER_ORDER
from dembrane.settings import get_settings
from dembrane.tier_downgrade import preview_downgrade, apply_downgrade_effects
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.v2.schemas import (
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
    MemberPreview,
    TeamRollup,
    WorkspaceListResponse,
    WorkspaceSummary,
    WorkspaceUsage,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

settings = get_settings()

# Keep upgrade requests from flooding the billing inbox if someone spams the
# button (or if the UI misfires and retries on every click).
_upgrade_request_rate_limiter = create_user_rate_limiter(
    name="upgrade_request", capacity=5, window_seconds=3600
)


def _strip_header_unsafe(value: str) -> str:
    """Remove CR/LF from strings that will appear inside an email Subject.

    SendGrid's API is generally tolerant, but a well-formed newline in the
    subject can still corrupt downstream delivery or inject headers on
    SMTP relays we don't control.
    """
    if not value:
        return ""
    return value.replace("\r", " ").replace("\n", " ").strip()

router = APIRouter()
logger = getLogger("api.v2.workspaces")


async def _get_workspace_usage(ws_id: str) -> WorkspaceUsage:
    """Get audio hours + conversation count for a workspace (all-time and current month)."""
    # Get all projects in this workspace
    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ws_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list) or len(projects) == 0:
        return WorkspaceUsage()

    project_ids = [p["id"] for p in projects]

    # Get all conversations across those projects (include created_at for monthly filtering)
    conversations = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": {"_in": project_ids},
                    "deleted_at": {"_null": True},
                },
                "fields": ["duration", "created_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(conversations, list):
        return WorkspaceUsage()

    # All-time totals
    total_seconds = sum(c.get("duration") or 0 for c in conversations)

    # Current month totals
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    monthly_seconds = 0
    monthly_count = 0
    for c in conversations:
        created_at = c.get("created_at")
        if created_at and created_at >= month_start:
            monthly_seconds += c.get("duration") or 0
            monthly_count += 1

    return WorkspaceUsage(
        audio_hours=round(total_seconds / 3600, 1),
        conversation_count=len(conversations),
        audio_hours_this_month=round(monthly_seconds / 3600, 1),
        conversations_this_month=monthly_count,
    )


async def _get_member_previews(ws_id: str) -> list[MemberPreview]:
    """Get first 4 member avatars for a workspace.

    Uses get_effective_members so derived team admins are represented.
    Raw workspace_membership reads would show only direct rows and lie
    about who's on open workspaces. (Audit round 2026-04-21, MEDIUM.)
    """
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(ws_id)
    if not members:
        return []
    # Direct rows bubble to the top of get_effective_members.sort() so
    # previews are deterministic and prioritise explicit membership.
    user_ids = [m["user_id"] for m in members[:4] if m.get("user_id")]
    if not user_ids:
        return []

    users = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["id", "display_name", "directus_user_id"],
                "limit": 4,
            }
        },
    )
    if not isinstance(users, list):
        return []

    # Fetch avatars from directus_users
    du_ids = [u["directus_user_id"] for u in users if u.get("directus_user_id")]
    avatar_map: dict[str, Optional[str]] = {}
    if du_ids:
        profiles = await async_directus.get_users(
            {"query": {"filter": {"id": {"_in": du_ids}}, "fields": ["id", "avatar"], "limit": 4}}
        )
        if isinstance(profiles, list):
            avatar_map = {u["id"]: u.get("avatar") for u in profiles}

    return [
        MemberPreview(
            display_name=u.get("display_name", ""),
            avatar=avatar_map.get(u.get("directus_user_id", "")),
        )
        for u in users
    ]


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    auth: DependencyDirectusSession,
) -> WorkspaceListResponse:
    """List all accessible workspaces with usage stats and team rollups."""
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        return WorkspaceListResponse(workspaces=[], teams=[])

    app_user_id = app_user["id"]

    # Get all active workspace memberships
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["workspace_id", "role", "source", "is_external"],
                "limit": -1,
            }
        },
    )

    if not isinstance(memberships, list) or len(memberships) == 0:
        return WorkspaceListResponse(workspaces=[], teams=[])

    workspace_ids = [m["workspace_id"] for m in memberships if m.get("workspace_id")]

    # Fetch workspace details
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "id": {"_in": workspace_ids},
                    "deleted_at": {"_null": True},
                },
                "fields": [
                    "id", "name", "org_id", "is_default", "tier",
                    "downgraded_at", "downgraded_from_tier",
                ],
                "limit": -1,
            }
        },
    )
    if not isinstance(workspaces, list):
        workspaces = []

    ws_map = {ws["id"]: ws for ws in workspaces}

    # Fetch org names
    org_ids = list({ws.get("org_id") for ws in workspaces if ws.get("org_id")})
    org_map: dict[str, str] = {}
    if org_ids:
        orgs = await async_directus.get_items(
            "org",
            {"query": {"filter": {"id": {"_in": org_ids}}, "fields": ["id", "name"], "limit": -1}},
        )
        if isinstance(orgs, list):
            org_map = {o["id"]: o.get("name", "") for o in orgs}

    # Build workspace summaries with usage — parallelize per-workspace queries
    # Filter to valid memberships first
    valid_memberships = [(m, ws_map[m["workspace_id"]]) for m in memberships if ws_map.get(m.get("workspace_id"))]

    async def _get_workspace_aggregates(ws_id: str) -> tuple[int, int, WorkspaceUsage, list[MemberPreview]]:
        """Fetch project count, member count, usage, and member previews in parallel."""
        proj_task = async_directus.get_items(
            "project",
            {"query": {"filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}}, "aggregate": {"count": ["id"]}}},
        )
        mem_task = async_directus.get_items(
            "workspace_membership",
            {"query": {"filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}}, "aggregate": {"count": ["id"]}}},
        )
        usage_task = _get_workspace_usage(ws_id)
        previews_task = _get_member_previews(ws_id)

        proj_count_result, mem_count_result, usage, previews = await asyncio.gather(
            proj_task, mem_task, usage_task, previews_task
        )

        project_count = 0
        if isinstance(proj_count_result, list) and len(proj_count_result) > 0:
            project_count = int(proj_count_result[0].get("count", {}).get("id", 0))
        member_count = 0
        if isinstance(mem_count_result, list) and len(mem_count_result) > 0:
            member_count = int(mem_count_result[0].get("count", {}).get("id", 0))

        return project_count, member_count, usage, previews

    # Run all workspace aggregate queries in parallel across all workspaces
    all_aggregates = await asyncio.gather(
        *[_get_workspace_aggregates(ws["id"]) for _, ws in valid_memberships]
    )

    results: list[WorkspaceSummary] = []
    for (membership, ws), (project_count, member_count, usage, previews) in zip(valid_memberships, all_aggregates):
        results.append(WorkspaceSummary(
            id=ws["id"],
            name=ws.get("name", ""),
            org_id=ws.get("org_id", ""),
            org_name=org_map.get(ws.get("org_id", ""), ""),
            role=membership.get("role", ""),
            is_default=ws.get("is_default", False),
            tier=ws.get("tier", "pioneer"),
            project_count=project_count,
            member_count=member_count,
            is_external=membership.get("is_external", False),
            members_preview=previews,
            usage=usage,
            downgraded_at=ws.get("downgraded_at"),
            downgraded_from_tier=ws.get("downgraded_from_tier"),
        ))

    # Build team rollups
    teams: list[TeamRollup] = []
    org_membership_data = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": app_user_id}, "deleted_at": {"_null": True}},
                "fields": ["org_id", "role"],
                "limit": -1,
            }
        },
    )
    if isinstance(org_membership_data, list):
        # Build org-to-workspaces map and collect all workspace IDs for member queries
        org_team_workspaces: dict[str, list[WorkspaceSummary]] = {}
        all_team_ws_ids: list[str] = []
        valid_org_memberships = []
        for om in org_membership_data:
            oid = om.get("org_id")
            if not oid:
                continue
            team_ws = [w for w in results if w.org_id == oid]
            org_team_workspaces[oid] = team_ws
            all_team_ws_ids.extend(tw.id for tw in team_ws)
            valid_org_memberships.append(om)

        # Fetch all workspace memberships for team rollups in parallel
        all_team_mems = await asyncio.gather(
            *[
                async_directus.get_items(
                    "workspace_membership",
                    {"query": {"filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}}, "fields": ["user_id"], "limit": -1}},
                )
                for ws_id in all_team_ws_ids
            ]
        ) if all_team_ws_ids else []

        # Build ws_id -> member user_ids map
        ws_member_map: dict[str, set[str]] = {}
        for ws_id, mems in zip(all_team_ws_ids, all_team_mems):
            member_ids: set[str] = set()
            if isinstance(mems, list):
                member_ids = {m["user_id"] for m in mems if m.get("user_id")}
            ws_member_map[ws_id] = member_ids

        for om in valid_org_memberships:
            oid = om["org_id"]
            team_workspaces = org_team_workspaces[oid]
            all_member_ids: set[str] = set()
            for tw in team_workspaces:
                all_member_ids.update(ws_member_map.get(tw.id, set()))

            teams.append(TeamRollup(
                id=oid,
                name=org_map.get(oid, ""),
                role=om.get("role", ""),
                total_projects=sum(w.project_count for w in team_workspaces),
                total_members=len(all_member_ids),
                total_audio_hours=round(sum(w.usage.audio_hours for w in team_workspaces), 1),
                total_conversations=sum(w.usage.conversation_count for w in team_workspaces),
                workspace_count=len(team_workspaces),
                total_audio_hours_this_month=round(sum(w.usage.audio_hours_this_month for w in team_workspaces), 1),
                total_conversations_this_month=sum(w.usage.conversations_this_month for w in team_workspaces),
            ))

    return WorkspaceListResponse(workspaces=results, teams=teams)


@router.post("", response_model=CreateWorkspaceResponse)
async def create_workspace(
    body: CreateWorkspaceRequest,
    auth: DependencyDirectusSession,
) -> CreateWorkspaceResponse:
    """Create a new workspace in the user's team."""
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    # Determine which org to create in
    org_id = body.org_id
    if not org_id:
        # Use user's primary org (where they're owner)
        orgs = await async_directus.get_items(
            "org_membership",
            {"query": {"filter": {"user_id": {"_eq": app_user_id}, "role": {"_in": ["owner", "admin"]}, "deleted_at": {"_null": True}}, "fields": ["org_id"], "limit": 1}},
        )
        if not isinstance(orgs, list) or len(orgs) == 0:
            raise HTTPException(status_code=403, detail="No team found. Complete onboarding first.")
        org_id = orgs[0]["org_id"]

    # Verify user has admin/owner on this org
    org_access = await async_directus.get_items(
        "org_membership",
        {"query": {"filter": {"org_id": {"_eq": org_id}, "user_id": {"_eq": app_user_id}, "role": {"_in": ["owner", "admin"]}, "deleted_at": {"_null": True}}, "limit": 1}},
    )
    if not isinstance(org_access, list) or len(org_access) == 0:
        raise HTTPException(status_code=403, detail="Must be team admin or owner to create workspaces")

    # Tier is always "pioneer" on creation — plan changes happen via admin/billing
    # Matrix v1.1 §6 visibility: stored on workspace.visibility. The enum
    # is the sole source of truth on new workspaces; legacy settings flags
    # are no longer written (resolver still reads them for pre-enum rows).
    visibility = "open_to_team" if body.inherit_team_admins else "private"
    ws_id = generate_uuid()
    await async_directus.create_item("workspace", {
        "id": ws_id,
        "org_id": org_id,
        "name": body.name.strip(),
        "tier": "pioneer",
        "visibility": visibility,
        "is_default": False,
        "created_by": app_user_id,
    })

    # Insert the creator as source='direct', role='owner'. No settings
    # flags (matrix v1.1 §6 — derivation is retired for new rows).
    from dembrane.inheritance import on_workspace_created
    await on_workspace_created(
        workspace_id=ws_id,
        creator_app_user_id=app_user_id,
    )

    logger.info(
        f"Created workspace {ws_id} '{body.name}' in org {org_id} by {app_user_id} "
        f"(visibility={visibility})"
    )

    # Tell the team's other admins/owners that a new workspace exists.
    # Open workspaces are discoverable via the discovery endpoint so they
    # can explicitly join; private workspaces are still discoverable to
    # team admins per matrix §6.
    from dembrane.notifications import emit_to_audience, audience_team_admins
    creator_row = await async_directus.get_item("app_user", app_user_id)
    creator_name = (creator_row or {}).get("display_name") or "A team admin"
    team_admin_ids = await audience_team_admins(org_id)
    await emit_to_audience(
        team_admin_ids,
        actor_user_id=app_user_id,
        event_code="WORKSPACE_CREATED",
        title=f"{creator_name} created {body.name.strip()}",
        message=(
            "The new workspace is open to the team — discover it from your team page."
            if visibility == "open_to_team"
            else "The new workspace is private — only explicitly invited people and team admins have access."
        ),
        action="NAVIGATE_WS",
        ref_workspace_id=ws_id,
        ref_org_id=org_id,
    )

    return CreateWorkspaceResponse(
        id=ws_id,
        name=body.name.strip(),
        org_id=org_id,
        tier="pioneer",  # Matches what we actually stored
    )


# ── DELETE workspace ────────────────────────────────────────────────────


@router.delete("/{workspace_id}")
async def delete_workspace(
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Soft-delete a workspace. Admin or owner. Blocked if workspace has
    any non-deleted project — partners wind projects down via the team
    admin page's Projects view (matrix §4 + S7).

    Matrix §4 delete-workspace row is ✓ on Admin (with confirmation
    footnote), so we accept admin here. Billing + member still 403.
    """
    if ctx.role not in ("admin", "owner"):
        raise HTTPException(
            status_code=403,
            detail="Only a workspace admin or owner can delete this workspace",
        )

    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "deleted_at": {"_null": True},
                },
                "aggregate": {"count": "id"},
            }
        },
    )
    project_count = 0
    if isinstance(projects, list) and projects:
        project_count = int(projects[0].get("count", {}).get("id", 0) or 0)

    if project_count > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This workspace has {project_count} project(s). "
                "Delete or move them first — you can do this from the team's Projects view."
            ),
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item(
        "workspace", ctx.workspace_id, {"deleted_at": now_iso}
    )
    logger.info(
        f"Deleted workspace {ctx.workspace_id} by {ctx.app_user_id} "
        f"(role={ctx.role})"
    )
    return {"status": "deleted"}


# ── Tier management (staff-only per D1 / Ask 2s) ────────────────────────


class SetTierRequest(BaseModel):
    tier: Literal["pilot", "pioneer", "innovator", "changemaker", "guardian"]
    reason: str = Field(
        min_length=1,
        max_length=500,
        description="Internal note for the staff audit trail (D17).",
    )


class SetTierResponse(BaseModel):
    workspace_id: str
    previous_tier: str
    new_tier: str
    direction: Literal["upgrade", "downgrade", "no-change"]
    effects_applied: list[dict] = []


@router.patch("/{workspace_id}/tier", response_model=SetTierResponse)
async def set_workspace_tier(
    workspace_id: str,
    body: SetTierRequest,
    auth: DependencyDirectusSession,
) -> SetTierResponse:
    """Staff-only tier change. Applies DOWNGRADE_EFFECTS when going down.

    Direction + reason are logged for the (future) staff audit surface.
    The reason field is required (D17) so every change has a paper trail.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only action")

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    from_tier = workspace.get("tier", "pioneer")
    to_tier = body.tier

    try:
        direction: Literal["upgrade", "downgrade", "no-change"]
        from_idx = TIER_ORDER.index(from_tier)
        to_idx = TIER_ORDER.index(to_tier)
    except ValueError:
        raise HTTPException(status_code=500, detail="Unknown tier value")

    if from_idx == to_idx:
        direction = "no-change"
    elif to_idx > from_idx:
        direction = "upgrade"
    else:
        direction = "downgrade"

    effects: list[dict] = []
    if direction == "downgrade":
        # Order matters: compute effects on the pre-change state, apply
        # revert mutations, then update the tier. If we updated tier first,
        # has_policy would already be denying policies we need to read.
        effects = await apply_downgrade_effects(workspace_id, from_tier, to_tier)

    # Tier change + downgrade-banner state. On downgrade we stamp
    # downgraded_at + downgraded_from_tier so the frontend renders the
    # 7-day banner (matrix v1.1 §3). On upgrade we clear those so the
    # banner goes away immediately — an upgrade makes the old downgrade
    # irrelevant. No-change: touch nothing.
    now_iso = datetime.now(timezone.utc).isoformat()
    ws_update: dict = {"tier": to_tier}
    if direction == "downgrade":
        ws_update["downgraded_at"] = now_iso
        ws_update["downgraded_from_tier"] = from_tier
    elif direction == "upgrade":
        ws_update["downgraded_at"] = None
        ws_update["downgraded_from_tier"] = None
    await async_directus.update_item("workspace", workspace_id, ws_update)

    # Bust the cached usage rollup so the UI reflects the new tier's
    # caps + rates on the next read. Both the workspace-scope cache and
    # the org-scope aggregate depend on tier info, so bust both.
    if direction != "no-change":
        from dembrane.cache_utils import (
            invalidate_workspace_usage,
            invalidate_org_usage,
        )
        await invalidate_workspace_usage(workspace_id)
        ws_org_id = workspace.get("org_id")
        if ws_org_id:
            await invalidate_org_usage(ws_org_id)

    logger.info(
        f"STAFF tier change: workspace {workspace_id} {from_tier} → {to_tier} "
        f"(direction={direction}, by={auth.user_id}, reason={body.reason!r}, "
        f"effects={[e['policy'] for e in effects]})"
    )

    # Notify workspace admins/owners + billing so they know about the tier
    # change. Staff changes bypass the usual admin flow — without this
    # notification admins would see feature gates flip (or logo disappear)
    # with no explanation. Matrix v1.1 §3 audience = admin + billing.
    if direction != "no-change":
        from dembrane.notifications import (
            emit_to_audience,
            audience_workspace_admins_and_billing,
        )
        ws_name = workspace.get("name", "your workspace")
        if direction == "upgrade":
            title = f"{ws_name} upgraded to {to_tier}"
            message = f"You now have {to_tier}-tier features unlocked."
        else:
            title = f"{ws_name} moved to {to_tier}"
            effect_list = ", ".join(e.get("human", "") for e in effects if e.get("human"))
            message = (
                f"Some features are now limited: {effect_list}."
                if effect_list
                else "Some features are now limited."
            )
        audience = await audience_workspace_admins_and_billing(workspace_id)
        await emit_to_audience(
            audience,
            event_code=(
                "TIER_UPGRADED" if direction == "upgrade" else "TIER_DOWNGRADED"
            ),
            title=title,
            message=message,
            action="NAVIGATE_WS",
            ref_workspace_id=workspace_id,
        )

        # Matrix v1.1 §3 requires a post-downgrade email within 1 minute to
        # every admin + billing user. Queue via Dramatiq network actor
        # (task_send_downgrade_email) so the PATCH returns immediately;
        # the worker picks it up on the next cycle. "Within 1 minute"
        # holds comfortably under normal queue latency.
        if direction == "downgrade" and audience:
            from dembrane.tasks import task_send_downgrade_email
            task_send_downgrade_email.send(
                audience,
                ws_name,
                workspace_id,
                from_tier,
                to_tier,
                effects,
                now_iso,
            )

    return SetTierResponse(
        workspace_id=workspace_id,
        previous_tier=from_tier,
        new_tier=to_tier,
        direction=direction,
        effects_applied=effects,
    )


@router.get("/{workspace_id}/tier/preview-downgrade")
async def preview_workspace_downgrade(
    to_tier: Literal["pilot", "pioneer", "innovator", "changemaker", "guardian"],
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """What would a downgrade to `to_tier` do? Read-only — powers the W5
    confirmation dialog copy. Anyone with settings:manage can preview.
    """
    ctx.require_policy("settings:manage")
    current = ctx.workspace.get("tier", "pioneer")
    return {
        "from_tier": current,
        "to_tier": to_tier,
        "effects": await preview_downgrade(ctx.workspace_id, current, to_tier),
    }


# ── Upgrade request (Ask 2 + 4C "Request upgrade" CTA, admin-role only) ─


class UpgradeRequestBody(BaseModel):
    target_tier: Optional[
        Literal["pioneer", "innovator", "changemaker", "guardian"]
    ] = None
    message: Optional[str] = Field(default=None, max_length=1000)


@router.post("/{workspace_id}/upgrade-request")
async def request_upgrade(
    body: UpgradeRequestBody,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Admin or billing clicks "Request upgrade" in the tier compare view.
    Sends an email to settings.email.upgrade_request_inbox with context.
    Configurable via UPGRADE_REQUEST_INBOX env var (defaults to
    upgrades@dembrane.com per matrix v1.1 §11).

    Member role doesn't see this CTA (matrix §11 — member-role path shows
    copy only, no button). Enforced here by require_policy(upgrade:request)
    which admin and billing have — members do not.

    Rate-limited per-user (5/hr) to avoid flooding the billing inbox when
    the UI misfires or a bored admin leans on the button.
    """
    ctx.require_policy("upgrade:request")

    await _upgrade_request_rate_limiter.check(ctx.app_user_id)

    requester = await async_directus.get_item("app_user", ctx.app_user_id)
    requester_name = (requester or {}).get("display_name") or ""
    requester_email = (requester or {}).get("email") or ""

    workspace_name = ctx.workspace.get("name", "")
    current_tier = ctx.workspace.get("tier", "pioneer")
    org = await async_directus.get_item("org", ctx.workspace.get("org_id"))
    org_name = (org or {}).get("name", "")

    target = body.target_tier or "(not specified)"

    # Rendered via the autoescaping Jinja env — user-controlled fields
    # (workspace_name, org_name, requester_name, message) are safe.
    template_data = {
        "org_name": org_name,
        "workspace_name": workspace_name,
        "workspace_id": ctx.workspace_id,
        "current_tier": current_tier,
        "target_tier": target,
        "requester_name": requester_name,
        "requester_email": requester_email,
        "message": body.message or "",
    }

    # Subject is not templated — belt-and-braces strip of CR/LF from fields
    # that end up there.
    safe_org = _strip_header_unsafe(org_name)
    safe_workspace = _strip_header_unsafe(workspace_name)
    subject = (
        f"Upgrade request: {safe_org} / {safe_workspace} "
        f"({current_tier} → {target})"
    )

    sent = await send_email(
        to=settings.email.upgrade_request_inbox,
        subject=subject,
        template="upgrade_request",
        template_data=template_data,
    )
    if not sent:
        # Don't silently drop — mirrors the pattern from 9021900.
        logger.error(
            f"Upgrade request email failed for workspace {ctx.workspace_id}"
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't send the request. Please try again or email us directly.",
        )

    logger.info(
        f"Upgrade request: workspace {ctx.workspace_id} {current_tier} → {target} "
        f"by {ctx.app_user_id}"
    )

    # Tell co-admins that a request is out so two of them don't both
    # email the billing inbox with the same ask. Skips the requester.
    from dembrane.notifications import emit_to_audience, audience_workspace_admins
    audience = await audience_workspace_admins(ctx.workspace_id)
    await emit_to_audience(
        audience,
        actor_user_id=ctx.app_user_id,
        event_code="UPGRADE_REQUEST_SENT",
        title=f"{requester_name or 'A team admin'} requested an upgrade",
        message=(
            f"**{workspace_name}** · {current_tier} → {target}. "
            "We'll follow up over email."
        ),
        action="NAVIGATE_WS",
        ref_workspace_id=ctx.workspace_id,
        ref_org_id=ctx.workspace.get("org_id"),
    )

    return {"status": "sent"}


# ────────────────────────────────────────────────────────────────────
# Usage rollup (matrix §8)
# ────────────────────────────────────────────────────────────────────


def _calendar_month_bounds(now: datetime) -> tuple[str, str]:
    """Return (iso_start, iso_end_of_next_month) for the calendar month
    containing `now`. Month-end is exclusive (so < next_start is the
    inclusive-of-this-month check)."""
    month_start = now.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    if now.month == 12:
        next_start = month_start.replace(year=now.year + 1, month=1)
    else:
        next_start = month_start.replace(month=now.month + 1)
    return month_start.isoformat(), next_start.isoformat()


class ProjectUsageItem(BaseModel):
    id: str
    name: str
    audio_hours: float
    conversation_count: int


class NextTierRecommendation(BaseModel):
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]
    price_note: str
    included_hours: Optional[int]
    included_seats: Optional[int]


class WorkspaceUsageResponse(BaseModel):
    # Everyone with workspace:view_usage sees these.
    cycle_start: str
    cycle_end_exclusive: str
    tier: str
    tier_tagline: str
    audio_hours: float
    audio_hours_included: Optional[int]          # None = unlimited
    seat_count: int
    seat_count_included: Optional[int]
    guest_count: int
    guest_cap: Optional[int]
    project_count: int
    projects: list[ProjectUsageItem]
    pilot_hard_block_active: bool                 # informational for members too

    # Admin + billing only — None for members.
    overage_forecast_eur: Optional[float] = None
    seat_overage_eur: Optional[float] = None
    next_tier: Optional[NextTierRecommendation] = None


class TierCapacityItem(BaseModel):
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]
    price_note: str
    duration: str
    included_seats: Optional[int]
    seat_overage_eur: Optional[int]
    included_hours: Optional[int]
    hour_overage_eur: Optional[int]
    hard_block_on_hours: bool
    guest_cap: Optional[int]
    training_included: str


@router.get("/tier-capacities", response_model=list[TierCapacityItem])
async def list_tier_capacities() -> list[TierCapacityItem]:
    """The canonical tier × capacity matrix (matrix §1).

    Static per deployment — clients can cache indefinitely. Authentication
    is not required: this data is public pricing info + lives on the
    product's own pricing page anyway. Served here so every in-product
    surface (upgrade modal, billing tab, pricing comparison) reads from
    a single source.
    """
    from dembrane.tier_capacity import TIER_CAPACITIES

    return [
        TierCapacityItem(
            tier=cap.tier,
            tagline=cap.tagline,
            price_eur_monthly=cap.price_eur_monthly,
            price_note=cap.price_note,
            duration=cap.duration,
            included_seats=cap.included_seats,
            seat_overage_eur=cap.seat_overage_eur,
            included_hours=cap.included_hours,
            hour_overage_eur=cap.hour_overage_eur,
            hard_block_on_hours=cap.hard_block_on_hours,
            guest_cap=cap.guest_cap,
            training_included=cap.training_included,
        )
        for cap in TIER_CAPACITIES.values()
    ]


@router.get(
    "/{workspace_id}/usage",
    response_model=WorkspaceUsageResponse,
)
async def get_workspace_usage(
    ctx: WorkspaceContext = Depends(get_workspace_context),
    refresh: bool = False,
) -> WorkspaceUsageResponse:
    """Workspace usage rollup for the current calendar month.

    Members see raw numbers. Admin + billing additionally see overage
    forecast and tier recommendation (matrix §8).

    Implementation: hours derive from `conversation.duration` SUM where
    `deleted_at IS NULL AND created_at >= month_start AND created_at <
    next_month_start`. No separate `usage_event` table (D9).

    Caching: 30-minute Redis cache of the full (admin-view) response,
    keyed by workspace. Member responses are derived from the cached
    admin response by zeroing the financial fields. Cache is busted on
    tier change (see set_workspace_tier). Pass `?refresh=true` to
    force a recompute + cache overwrite.
    """
    from dembrane.cache_utils import (
        USAGE_TTL_SECONDS,
        cache_get_json,
        cache_set_json,
        usage_cache_key,
    )
    from dembrane.tier_capacity import (
        compute_hour_overage_eur,
        compute_seat_overage_eur,
        get_capacity,
        next_tier as tier_next,
    )

    ctx.require_policy("workspace:view_usage")

    # Guest exclusion. Matrix §4 "View usage & overage" row grants Admin /
    # Billing / Member but not Guest. Our preset system gives guests the
    # member preset (guest = is_external=true on a direct row), so we gate
    # here explicitly rather than forking the preset.
    if ctx.is_external:
        raise HTTPException(status_code=403, detail="Guests don't see workspace usage")

    # Role-class decides whether financial fields are returned. We always
    # compute + cache the full-admin response; member response nulls the
    # financial fields at serialisation time.
    sees_financials = ctx.has_policy("workspace:view_invoices")

    cache_key = usage_cache_key(ctx.workspace_id)
    if not refresh:
        cached = await cache_get_json(cache_key)
        if isinstance(cached, dict):
            if not sees_financials:
                cached = {
                    **cached,
                    "overage_forecast_eur": None,
                    "seat_overage_eur": None,
                    "next_tier": None,
                }
            return WorkspaceUsageResponse(**cached)

    now = datetime.now(timezone.utc)
    cycle_start, cycle_end_exclusive = _calendar_month_bounds(now)

    # Projects in workspace (also used for per-project breakdown).
    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "name"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list):
        projects = []

    project_ids = [p["id"] for p in projects if p.get("id")]

    # Conversations in this workspace, this cycle.
    if project_ids:
        conversations = await async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {
                        "project_id": {"_in": project_ids},
                        "deleted_at": {"_null": True},
                        "created_at": {
                            "_gte": cycle_start,
                            "_lt": cycle_end_exclusive,
                        },
                    },
                    "fields": ["project_id", "duration"],
                    "limit": -1,
                }
            },
        )
    else:
        conversations = []
    if not isinstance(conversations, list):
        conversations = []

    # Per-project and total aggregates.
    per_project_seconds: dict[str, int] = {}
    per_project_count: dict[str, int] = {}
    total_seconds = 0
    for c in conversations:
        pid = c.get("project_id")
        if not pid:
            continue
        sec = int(c.get("duration") or 0)
        total_seconds += sec
        per_project_seconds[pid] = per_project_seconds.get(pid, 0) + sec
        per_project_count[pid] = per_project_count.get(pid, 0) + 1

    per_project_items = [
        ProjectUsageItem(
            id=p["id"],
            name=p.get("name", ""),
            audio_hours=round(per_project_seconds.get(p["id"], 0) / 3600, 2),
            conversation_count=per_project_count.get(p["id"], 0),
        )
        for p in projects
    ]

    audio_hours = round(total_seconds / 3600, 2)

    # Seat + guest count. Members + admin + billing count as seats; guest
    # (is_external=true) is its own bucket and is not billed (matrix §7).
    members = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role", "is_external"],
                "limit": -1,
            }
        },
    )
    if not isinstance(members, list):
        members = []

    # Seat + guest count — deduplicated by user_id. Matrix §7 says "one
    # seat per person per workspace", so we count distinct users, not
    # distinct rows. Pre-walkback data can carry both a source='direct'
    # row and a legacy source='inherited' row for the same (workspace,
    # user) pair, and a naive row-count would double-bill the same
    # human.
    #
    # Direct rows take priority over inherited (matches inheritance.py
    # get_effective_members: a user's direct role supersedes their
    # derived one). is_external is read from the winning row.
    by_user: dict[str, dict] = {}
    for m in members:
        uid = m.get("user_id")
        if not uid:
            continue
        # Skip rows with no role or with a retired role value that
        # wouldn't count either way.
        role = m.get("role")
        existing = by_user.get(uid)
        if existing is None:
            by_user[uid] = m
            continue
        # Prefer direct over inherited. If both are direct (shouldn't
        # happen, but guard), keep the one with a seat-worthy role over
        # a non-seat one.
        existing_direct = existing.get("source") == "direct"
        this_direct = m.get("source") == "direct"
        if this_direct and not existing_direct:
            by_user[uid] = m
        elif this_direct and existing_direct:
            # Double-direct: prefer the seat-worthy role.
            seat_roles = {"owner", "admin", "member", "billing"}
            if role in seat_roles and existing.get("role") not in seat_roles:
                by_user[uid] = m

    seat_count = 0
    guest_count = 0
    for m in by_user.values():
        role = m.get("role")
        if m.get("is_external"):
            # Guest bucket. A guest with an elevated role (admin/billing/
            # owner) shouldn't exist — blocked at invite + change-role — but
            # log if we ever see one so ops can spot it.
            if role in ("admin", "billing", "owner"):
                logger.warning(
                    "external_with_elevated_role workspace=%s role=%s",
                    ctx.workspace_id, role,
                )
            guest_count += 1
            continue
        if role in ("owner", "admin", "member", "billing"):
            seat_count += 1

    # Tier capacity lookup. Legacy rows with NULL tier fall through to the
    # unknown-tier path below (unlimited / no block) rather than silently
    # adopting Pilot defaults — the Pilot hard-block is only fair when
    # the workspace was explicitly set to Pilot.
    tier = ctx.workspace.get("tier") or ""
    cap = get_capacity(tier)
    if cap is None:
        # Unknown tier — treat as unlimited / no block. Safer default
        # than crashing on a legacy row.
        tagline = ""
        included_hours: Optional[int] = None
        included_seats: Optional[int] = None
        guest_cap: Optional[int] = None
        hard_block = False
    else:
        tagline = cap.tagline
        included_hours = cap.included_hours
        included_seats = cap.included_seats
        guest_cap = cap.guest_cap
        hard_block = (
            cap.hard_block_on_hours
            and cap.included_hours is not None
            and audio_hours >= cap.included_hours
        )

    # Always compute the full admin-view payload so the cache holds one
    # variant; members get a filtered copy at serialisation time.
    overage_forecast = compute_hour_overage_eur(tier, audio_hours)
    seat_overage = compute_seat_overage_eur(tier, seat_count)
    recommended = tier_next(tier)
    next_rec: Optional[NextTierRecommendation] = None
    if recommended:
        rcap = get_capacity(recommended)
        if rcap:
            next_rec = NextTierRecommendation(
                tier=recommended,
                tagline=rcap.tagline,
                price_eur_monthly=rcap.price_eur_monthly,
                price_note=rcap.price_note,
                included_hours=rcap.included_hours,
                included_seats=rcap.included_seats,
            )

    full = WorkspaceUsageResponse(
        cycle_start=cycle_start,
        cycle_end_exclusive=cycle_end_exclusive,
        tier=tier,
        tier_tagline=tagline,
        audio_hours=audio_hours,
        audio_hours_included=included_hours,
        seat_count=seat_count,
        seat_count_included=included_seats,
        guest_count=guest_count,
        guest_cap=guest_cap,
        project_count=len(projects),
        projects=per_project_items,
        pilot_hard_block_active=hard_block,
        overage_forecast_eur=overage_forecast,
        seat_overage_eur=seat_overage,
        next_tier=next_rec,
    )

    # Cache the full payload (admin view). Best-effort — failure to cache
    # never breaks the read.
    await cache_set_json(cache_key, full.model_dump(), USAGE_TTL_SECONDS)

    if not sees_financials:
        return WorkspaceUsageResponse(**{
            **full.model_dump(),
            "overage_forecast_eur": None,
            "seat_overage_eur": None,
            "next_tier": None,
        })

    return full
