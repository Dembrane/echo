"""V2 project endpoints — workspace-aware operations."""

from logging import getLogger
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import MoveProjectRequest, MoveProjectResponse
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.projects")


# ── Workspace-scoped project list ──


class V2ProjectSummary(BaseModel):
    id: str
    name: Optional[str] = None
    updated_at: Optional[str] = None
    language: Optional[str] = None
    pin_order: Optional[int] = None
    conversations_count: int = 0


class V2ProjectsListResponse(BaseModel):
    projects: list[V2ProjectSummary]
    total_count: int
    has_more: bool


@router.get("/workspace/{workspace_id}", response_model=V2ProjectsListResponse)
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

    # Total count
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

    return V2ProjectsListResponse(
        projects=projects,
        total_count=total_count,
        has_more=has_more,
    )


# ── Create project in workspace ──


class V2CreateProjectRequest(BaseModel):
    name: str = "New Project"
    language: str = "en"


class V2CreateProjectResponse(BaseModel):
    id: str
    name: str
    workspace_id: str


@router.post("/workspace/{workspace_id}", response_model=V2CreateProjectResponse)
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


# ── Move project ──


@router.post("/{project_id}/move", response_model=MoveProjectResponse)
async def move_project(
    project_id: str,
    body: MoveProjectRequest,
    auth: DependencyDirectusSession,
) -> MoveProjectResponse:
    """Move a project to a different workspace.

    Requires admin/owner on BOTH source and target workspace.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    target_workspace_id = body.target_workspace_id

    # Fetch the project
    project = await async_directus.get_item("project", project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    source_workspace_id = project.get("workspace_id")

    # If project is orphaned (no workspace), verify ownership via directus_user_id
    if not source_workspace_id:
        if project.get("directus_user_id") != auth.user_id:
            raise HTTPException(status_code=403, detail="Not the owner of this project")

    # Check access to source workspace (if project is in one)
    if source_workspace_id:
        source_membership = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": source_workspace_id},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not isinstance(source_membership, list) or len(source_membership) == 0:
            raise HTTPException(status_code=403, detail="No access to source workspace")
        source_role = source_membership[0].get("role", "")
        if source_role not in ("admin", "owner"):
            raise HTTPException(status_code=403, detail="Must be admin or owner of source workspace")

    # Check access to target workspace
    target_membership = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": target_workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    if not isinstance(target_membership, list) or len(target_membership) == 0:
        raise HTTPException(status_code=403, detail="No access to target workspace")
    target_role = target_membership[0].get("role", "")
    if target_role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Must be admin or owner of target workspace")

    # Verify target workspace exists and is not deleted
    target_workspace = await async_directus.get_item("workspace", target_workspace_id)
    if not target_workspace or target_workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Target workspace not found")

    # Move the project
    await async_directus.update_item("project", project_id, {
        "workspace_id": target_workspace_id,
    })

    logger.info(
        f"Moved project {project_id} from workspace {source_workspace_id} "
        f"to {target_workspace_id} by user {app_user_id}"
    )

    return MoveProjectResponse(
        project_id=project_id,
        workspace_id=target_workspace_id,
    )
