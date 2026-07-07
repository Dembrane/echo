"""BFF endpoints for project goals and methodologies."""

from __future__ import annotations

from typing import Optional

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.utils import generate_uuid
from dembrane.methodologies import list_visible_methodologies
from dembrane.project_goals import to_goal_revision, list_project_goal_revisions
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import get_workspace_context
from dembrane.api.v2.bff._access import resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()  # /v2/bff/projects
methodologies_router = APIRouter()  # /v2/bff/methodologies


class GoalCreate(BaseModel):
    content: str = Field(..., min_length=1)
    chat_id: Optional[str] = None


@router.get("/{project_id}/goal")
async def get_project_goal(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")

    revisions = await list_project_goal_revisions(project_id)
    return {
        "current": revisions[0] if revisions else None,
        "revisions": revisions,
    }


@router.post("/{project_id}/goal")
async def create_project_goal_revision(
    project_id: str,
    body: GoalCreate,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(project_id, auth)
    access.require("project:update")

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    created = await async_directus.create_item(
        "project_goal_revision",
        {
            "id": generate_uuid(),
            "project_id": project_id,
            "content": content,
            "set_by": "host-edit",
            "chat_id": body.chat_id,
            "created_by": auth.user_id,
        },
    )
    row = created.get("data") if isinstance(created, dict) else created
    return to_goal_revision(row if isinstance(row, dict) else {})


@methodologies_router.get("")
async def list_methodologies(
    auth: DependencyDirectusSession,
    workspace_id: str = Query(..., min_length=1),
) -> list[dict]:
    await get_workspace_context(workspace_id, auth)
    return await list_visible_methodologies(
        workspace_id=workspace_id,
        directus_user_id=auth.user_id,
    )
