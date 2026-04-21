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


def _visibility_filter_for_caller(
    caller_role: str,
    shared_ids: set[str],
    creator_directus_id: Optional[str],
) -> Optional[dict]:
    """Build a Directus filter clause that server-side restricts the
    project query to visible rows for this caller.

    Admins/owners see everything → returns None (no extra clause).
    Non-admins see: workspace-visible OR shared-on OR legacy-creator.

    Keeps pagination and total_count honest — no post-filter Python slicing.
    """
    if caller_role in ("admin", "owner"):
        return None

    or_clauses: list[dict] = [
        {"visibility": {"_neq": "private"}},
        {"visibility": {"_null": True}},  # legacy rows with null visibility
    ]
    if shared_ids:
        or_clauses.append({"id": {"_in": list(shared_ids)}})
    if creator_directus_id:
        or_clauses.append({"directus_user_id": {"_eq": creator_directus_id}})

    return {"_or": or_clauses}


@router.get("/{workspace_id}/projects", response_model=V2ProjectsListResponse)
async def list_workspace_projects(
    auth: DependencyDirectusSession,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    search: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(15, ge=1, le=100),
) -> V2ProjectsListResponse:
    """List projects in a workspace. Requires project:read policy.

    Private projects (visibility='private') are filtered at the Directus
    query level (via `_or`) so pagination, has_more, and total_count
    remain server-authoritative. See inheritance.get_user_project_access
    for the access ladder this mirrors.
    """
    ctx.require_policy("project:read")

    shared_ids = await _shared_private_project_ids(ctx.app_user_id)
    visibility_clause = _visibility_filter_for_caller(
        caller_role=ctx.role,
        shared_ids=shared_ids,
        creator_directus_id=auth.user_id,
    )

    base_filter: dict = {
        "workspace_id": {"_eq": ctx.workspace_id},
        "deleted_at": {"_null": True},
    }
    effective_filter = (
        {**base_filter, **visibility_clause}
        if visibility_clause is not None
        else base_filter
    )

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
        "filter": effective_filter,
        "sort": ["-updated_at"],
        "limit": limit + 1,
        "offset": offset,
    }
    if search:
        query["search"] = search

    projects_raw = await async_directus.get_items("project", {"query": query})
    if not isinstance(projects_raw, list):
        projects_raw = []

    has_more = len(projects_raw) > limit
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
        for p in projects_raw[:limit]
    ]

    total_count = 0
    if not search:
        count_result = await async_directus.get_items(
            "project",
            {
                "query": {
                    "aggregate": {"count": ["id"]},
                    "filter": effective_filter,
                }
            },
        )
        if isinstance(count_result, list) and len(count_result) > 0:
            total_count = int(count_result[0].get("count", {}).get("id", 0))
    else:
        total_count = offset + len(projects) + (1 if has_more else 0)

    # Pinned list uses the same visibility filter so members don't see a
    # pinned private project they can't reach.
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
        "filter": {**effective_filter, "pin_order": {"_nnull": True}},
        "sort": ["pin_order"],
        "limit": 3,
    }})
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
        for p in (pinned_raw if isinstance(pinned_raw, list) else [])
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
