"""V2 workspace endpoints — list accessible workspaces."""

from logging import getLogger

from fastapi import APIRouter

from dembrane.app_user import resolve_app_user
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import MemberPreview, WorkspaceSummary, WorkspaceListResponse
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.workspaces")


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    auth: DependencyDirectusSession,
) -> WorkspaceListResponse:
    """List all workspaces accessible to the current user.

    Used by the workspace selector. Returns workspace details with
    role, project count, and member count.
    """
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        return WorkspaceListResponse(workspaces=[])

    app_user_id = app_user["id"]

    # Get all active workspace memberships for this user
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": [
                    "workspace_id",
                    "role",
                    "source",
                    "is_external",
                ],
                "limit": -1,
            }
        },
    )

    if not isinstance(memberships, list) or len(memberships) == 0:
        return WorkspaceListResponse(workspaces=[])

    # Fetch workspace details for all memberships
    workspace_ids = [m["workspace_id"] for m in memberships if m.get("workspace_id")]

    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "id": {"_in": workspace_ids},
                    "deleted_at": {"_null": True},
                },
                "fields": [
                    "id",
                    "name",
                    "org_id",
                    "is_default",
                    "tier",
                ],
                "limit": -1,
            }
        },
    )

    if not isinstance(workspaces, list):
        workspaces = []

    # Build a map of workspace_id -> workspace
    ws_map = {ws["id"]: ws for ws in workspaces}

    # Fetch org names
    org_ids = list({ws.get("org_id") for ws in workspaces if ws.get("org_id")})
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

    # Count projects and members per workspace
    results: list[WorkspaceSummary] = []

    for membership in memberships:
        ws_id = membership.get("workspace_id")
        ws = ws_map.get(ws_id)
        if not ws:
            continue

        # Count projects in this workspace
        project_count_result = await async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ws_id},
                        "deleted_at": {"_null": True},
                    },
                    "aggregate": {"count": ["id"]},
                }
            },
        )
        project_count = 0
        if isinstance(project_count_result, list) and len(project_count_result) > 0:
            project_count = int(project_count_result[0].get("count", {}).get("id", 0))

        # Count members in this workspace
        member_count_result = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ws_id},
                        "deleted_at": {"_null": True},
                    },
                    "aggregate": {"count": ["id"]},
                }
            },
        )
        member_count = 0
        if isinstance(member_count_result, list) and len(member_count_result) > 0:
            member_count = int(member_count_result[0].get("count", {}).get("id", 0))

        # Fetch first 4 members for avatar preview bubbles
        members_preview: list[MemberPreview] = []
        preview_memberships = await async_directus.get_items(
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
        if isinstance(preview_memberships, list) and len(preview_memberships) > 0:
            preview_user_ids = [m["user_id"] for m in preview_memberships if m.get("user_id")]
            if preview_user_ids:
                preview_users = await async_directus.get_items(
                    "app_user",
                    {
                        "query": {
                            "filter": {"id": {"_in": preview_user_ids}},
                            "fields": ["id", "display_name", "directus_user_id"],
                            "limit": 4,
                        }
                    },
                )
                if isinstance(preview_users, list):
                    # Fetch avatars from directus_users
                    du_ids = [u["directus_user_id"] for u in preview_users if u.get("directus_user_id")]
                    avatar_map: dict[str, str | None] = {}
                    if du_ids:
                        du_profiles = await async_directus.get_users(
                            {"query": {"filter": {"id": {"_in": du_ids}}, "fields": ["id", "avatar"], "limit": 4}}
                        )
                        if isinstance(du_profiles, list):
                            avatar_map = {u["id"]: u.get("avatar") for u in du_profiles}

                    for u in preview_users:
                        members_preview.append(MemberPreview(
                            display_name=u.get("display_name", ""),
                            avatar=avatar_map.get(u.get("directus_user_id", ""))
                        ))

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
            members_preview=members_preview,
        ))

    return WorkspaceListResponse(workspaces=results)
