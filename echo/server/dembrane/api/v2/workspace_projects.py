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


class V2ProjectSummary(BaseModel):
    id: str
    name: Optional[str] = None
    updated_at: Optional[str] = None
    language: Optional[str] = None
    pin_order: Optional[int] = None
    conversations_count: int = 0


class V2ProjectsListResponse(BaseModel):
    pinned: list[V2ProjectSummary] = []
    projects: list[V2ProjectSummary]
    total_count: int
    has_more: bool
    is_admin: bool = False


@router.get("/{workspace_id}/projects", response_model=V2ProjectsListResponse)
async def list_workspace_projects(
    ctx: WorkspaceContext = Depends(get_workspace_context),
    search: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(15, ge=1, le=100),
) -> V2ProjectsListResponse:
    """List projects in a workspace. Requires workspace membership."""
    base_filter: dict = {
        "workspace_id": {"_eq": ctx.workspace_id},
        "deleted_at": {"_null": True},
    }

    query: dict = {
        "fields": ["id", "name", "updated_at", "language", "pin_order", "count(conversations)"],
        "filter": base_filter,
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
        )
        for p in projects_raw[:limit]
    ]

    total_count = 0
    if not search:
        count_result = await async_directus.get_items(
            "project",
            {"query": {"aggregate": {"count": ["id"]}, "filter": base_filter}},
        )
        if isinstance(count_result, list) and len(count_result) > 0:
            total_count = int(count_result[0].get("count", {}).get("id", 0))
    else:
        total_count = offset + len(projects) + (1 if has_more else 0)

    # Fetch pinned projects (separate query, always shown regardless of search)
    pinned_raw = await async_directus.get_items("project", {"query": {
        "fields": ["id", "name", "updated_at", "language", "pin_order", "count(conversations)"],
        "filter": {**base_filter, "pin_order": {"_nnull": True}},
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
        )
        for p in (pinned_raw if isinstance(pinned_raw, list) else [])
    ]

    return V2ProjectsListResponse(
        pinned=pinned,
        projects=projects,
        total_count=total_count,
        has_more=has_more,
        is_admin=ctx.role in ("admin", "owner"),
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
