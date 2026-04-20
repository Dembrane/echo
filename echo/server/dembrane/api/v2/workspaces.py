"""V2 workspace endpoints — list, create, manage workspaces."""

import asyncio
from datetime import datetime, timezone
from logging import getLogger
from typing import Optional

from fastapi import APIRouter, HTTPException

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user, get_app_user_or_raise
from dembrane.directus_async import async_directus
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
    """Get first 4 member avatars for a workspace."""
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ws_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id"],
                "limit": 4,
            }
        },
    )
    if not isinstance(memberships, list) or len(memberships) == 0:
        return []

    user_ids = [m["user_id"] for m in memberships if m.get("user_id")]
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
                "fields": ["id", "name", "org_id", "is_default", "tier"],
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
    ws_id = generate_uuid()
    await async_directus.create_item("workspace", {
        "id": ws_id,
        "org_id": org_id,
        "name": body.name.strip(),
        "tier": "pioneer",
        "is_default": False,
        "created_by": app_user_id,
    })

    # Seed settings + creator membership via the inheritance module. No
    # fan-out of source='inherited' rows — derived model computes team
    # admin/member access at query time from org_membership + these flags.
    from dembrane.inheritance import on_workspace_created
    await on_workspace_created(
        workspace_id=ws_id,
        creator_app_user_id=app_user_id,
        inherit_team_admins=body.inherit_team_admins,
        inherit_team_members=body.inherit_team_members,
    )

    logger.info(
        f"Created workspace {ws_id} '{body.name}' in org {org_id} by {app_user_id} "
        f"(admins_follow={body.inherit_team_admins}, members_follow={body.inherit_team_members})"
    )

    return CreateWorkspaceResponse(
        id=ws_id,
        name=body.name.strip(),
        org_id=org_id,
        tier="pioneer",  # Matches what we actually stored
    )
