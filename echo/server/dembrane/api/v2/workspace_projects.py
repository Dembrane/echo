"""Workspace-scoped project endpoints: list and create."""

from logging import getLogger
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.workspace_projects")


async def _shared_private_project_ids(user_id: str) -> set[str]:
    """Return project_ids where this user has an explicit project_membership
    row. Used to un-hide private projects the user was shared on.
    """
    shares = await async_directus.get_items(
        "project_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": user_id}},
                "fields": ["project_id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(shares, list):
        return set()
    return {row["project_id"] for row in shares if row.get("project_id")}


def _filter_private_for_caller(
    projects: list[dict],
    *,
    caller_role: str,
    shared_ids: set[str],
    creator_directus_id: Optional[str],
) -> list[dict]:
    """Drop private projects the caller can't see.

    Visibility rules:
      - visibility='workspace' (or missing): always visible to workspace members.
      - visibility='private': visible only if caller is admin/owner of the
        workspace, OR has a project_membership row for this project, OR is
        the original creator (legacy `directus_user_id` match).
    """
    caller_is_admin = caller_role in ("admin", "owner")
    if caller_is_admin:
        return projects

    kept: list[dict] = []
    for project in projects:
        if (project.get("visibility") or "workspace") != "private":
            kept.append(project)
            continue
        if project["id"] in shared_ids:
            kept.append(project)
            continue
        if (
            creator_directus_id
            and project.get("directus_user_id") == creator_directus_id
        ):
            kept.append(project)
            continue
        # Fall-through: private, no share, not creator → hide.
    return kept


class V2ProjectSummary(BaseModel):
    id: str
    name: Optional[str] = None
    updated_at: Optional[str] = None
    language: Optional[str] = None
    pin_order: Optional[int] = None
    conversations_count: int = 0
    visibility: str = "workspace"


class V2ProjectsListResponse(BaseModel):
    pinned: list[V2ProjectSummary] = []
    projects: list[V2ProjectSummary]
    total_count: int
    has_more: bool
    is_admin: bool = False


@router.get("/{workspace_id}/projects", response_model=V2ProjectsListResponse)
async def list_workspace_projects(
    auth: DependencyDirectusSession,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    search: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(15, ge=1, le=100),
) -> V2ProjectsListResponse:
    """List projects in a workspace. Requires project:read policy.

    Private projects (visibility='private') are filtered out when the
    caller is neither a workspace admin/owner nor shared on the project
    via project_membership. See inheritance.get_user_project_access.
    """
    ctx.require_policy("project:read")
    base_filter: dict = {
        "workspace_id": {"_eq": ctx.workspace_id},
        "deleted_at": {"_null": True},
    }

    # Over-fetch slightly so the post-filter private trim doesn't
    # consistently short-change paginated results. Pragmatic: fetch 2x
    # requested + buffer, filter, then slice to `limit`.
    over_fetch = (limit * 2) + 10

    query: dict = {
        "fields": [
            "id",
            "name",
            "updated_at",
            "language",
            "pin_order",
            "visibility",
            "directus_user_id",
            "count(conversations)",
        ],
        "filter": base_filter,
        "sort": ["-updated_at"],
        "limit": over_fetch,
        "offset": offset,
    }
    if search:
        query["search"] = search

    projects_raw = await async_directus.get_items("project", {"query": query})
    if not isinstance(projects_raw, list):
        projects_raw = []

    shared_ids = await _shared_private_project_ids(ctx.app_user_id)
    visible = _filter_private_for_caller(
        projects_raw,
        caller_role=ctx.role,
        shared_ids=shared_ids,
        creator_directus_id=auth.user_id,
    )

    has_more = len(visible) > limit
    projects = [
        V2ProjectSummary(
            id=p["id"],
            name=p.get("name"),
            updated_at=p.get("updated_at"),
            language=p.get("language"),
            pin_order=p.get("pin_order"),
            conversations_count=int(p.get("conversations_count", 0) or 0),
            visibility=p.get("visibility") or "workspace",
        )
        for p in visible[:limit]
    ]

    total_count = 0
    if not search:
        if ctx.role in ("admin", "owner"):
            # Admins see every project — count is exact via Directus aggregate.
            count_result = await async_directus.get_items(
                "project",
                {"query": {"aggregate": {"count": ["id"]}, "filter": base_filter}},
            )
            if isinstance(count_result, list) and len(count_result) > 0:
                total_count = int(count_result[0].get("count", {}).get("id", 0))
        else:
            # Non-admin: we can't cheaply get the true count without a full
            # scan. Report the size of the visible slice + has_more hint;
            # UI can treat "total_count" as "at least N" here.
            total_count = offset + len(projects) + (1 if has_more else 0)
    else:
        total_count = offset + len(projects) + (1 if has_more else 0)

    # Fetch pinned projects (separate query, always shown regardless of search)
    pinned_raw = await async_directus.get_items("project", {"query": {
        "fields": [
            "id",
            "name",
            "updated_at",
            "language",
            "pin_order",
            "visibility",
            "directus_user_id",
            "count(conversations)",
        ],
        "filter": {**base_filter, "pin_order": {"_nnull": True}},
        "sort": ["pin_order"],
        "limit": 3,
    }})
    pinned_visible = _filter_private_for_caller(
        pinned_raw if isinstance(pinned_raw, list) else [],
        caller_role=ctx.role,
        shared_ids=shared_ids,
        creator_directus_id=auth.user_id,
    )
    pinned = [
        V2ProjectSummary(
            id=p["id"],
            name=p.get("name"),
            updated_at=p.get("updated_at"),
            language=p.get("language"),
            pin_order=p.get("pin_order"),
            conversations_count=int(p.get("conversations_count", 0) or 0),
            visibility=p.get("visibility") or "workspace",
        )
        for p in pinned_visible
    ]

    return V2ProjectsListResponse(
        pinned=pinned,
        projects=projects,
        total_count=total_count,
        has_more=has_more,
        is_admin=ctx.has_policy("settings:manage"),
    )


class V2CreateProjectRequest(BaseModel):
    name: str = "New Project"
    language: str = "en"


class V2CreateProjectResponse(BaseModel):
    id: str
    name: str
    workspace_id: str


@router.post("/{workspace_id}/projects", response_model=V2CreateProjectResponse)
async def create_workspace_project(
    body: V2CreateProjectRequest,
    auth: DependencyDirectusSession,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> V2CreateProjectResponse:
    """Create a project in a workspace. Requires project:create policy."""
    ctx.require_policy("project:create")

    project_id = generate_uuid()
    result = await async_directus.create_item("project", {
        "id": project_id,
        "name": body.name,
        "language": body.language,
        "workspace_id": ctx.workspace_id,
        "directus_user_id": auth.user_id,
        "is_conversation_allowed": True,
    })
    project = result["data"]

    logger.info(f"Created project {project_id} in workspace {ctx.workspace_id} by {ctx.app_user_id}")

    return V2CreateProjectResponse(
        id=project["id"],
        name=project.get("name", body.name),
        workspace_id=ctx.workspace_id,
    )
