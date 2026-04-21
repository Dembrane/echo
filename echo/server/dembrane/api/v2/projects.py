"""V2 project endpoints — non-workspace-scoped operations."""

from logging import getLogger
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.inheritance import user_can_access
from dembrane.policies import has_policy
from dembrane.api.v2.schemas import MoveProjectRequest, MoveProjectResponse
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.projects")


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

    project = await async_directus.get_item("project", project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    source_workspace_id = project.get("workspace_id")

    # Orphaned projects: verify ownership via directus_user_id
    if not source_workspace_id:
        if project.get("directus_user_id") != auth.user_id:
            raise HTTPException(status_code=403, detail="Not the owner of this project")

    # Check source workspace access
    if source_workspace_id:
        source_membership = await async_directus.get_items(
            "workspace_membership",
            {"query": {"filter": {
                "workspace_id": {"_eq": source_workspace_id},
                "user_id": {"_eq": app_user_id},
                "deleted_at": {"_null": True},
            }, "limit": 1}},
        )
        if not isinstance(source_membership, list) or len(source_membership) == 0:
            raise HTTPException(status_code=403, detail="No access to source workspace")
        if source_membership[0].get("role", "") not in ("admin", "owner"):
            raise HTTPException(status_code=403, detail="Must be admin or owner of source workspace")

    # Check target workspace access
    target_membership = await async_directus.get_items(
        "workspace_membership",
        {"query": {"filter": {
            "workspace_id": {"_eq": target_workspace_id},
            "user_id": {"_eq": app_user_id},
            "deleted_at": {"_null": True},
        }, "limit": 1}},
    )
    if not isinstance(target_membership, list) or len(target_membership) == 0:
        raise HTTPException(status_code=403, detail="No access to target workspace")
    if target_membership[0].get("role", "") not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Must be admin or owner of target workspace")

    target_workspace = await async_directus.get_item("workspace", target_workspace_id)
    if not target_workspace or target_workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Target workspace not found")

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


# ── Visibility toggle (workspace ↔ private) ─────────────────────────────


class SetVisibilityRequest(BaseModel):
    visibility: Literal["workspace", "private"]


@router.patch("/{project_id}/visibility")
async def set_project_visibility(
    project_id: str,
    body: SetVisibilityRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Flip a project between 'workspace' (visible to all workspace members)
    and 'private' (only creator + explicit project_membership shares).

    Going private is tier-gated at innovator+ via project:set_private.
    Requires workspace admin role; caller's access resolved via the
    derived-inheritance resolver (user_can_access).

    Existing project_membership rows are preserved across a flip — no
    auto-cleanup. Admin can curate after via the share modal.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    workspace_id = project.get("workspace_id")
    if not workspace_id:
        raise HTTPException(
            status_code=400,
            detail="Project is not attached to a workspace",
        )

    resolved = await user_can_access(workspace_id, app_user["id"])
    if resolved is None:
        raise HTTPException(status_code=403, detail="No access to this project")
    role, _ = resolved

    workspace = await async_directus.get_item("workspace", workspace_id)
    tier = (workspace or {}).get("tier", "pioneer")

    current = project.get("visibility") or "workspace"
    if current == body.visibility:
        return {"status": "unchanged", "visibility": current}

    # Going private is tier-gated. Going public is free (you're downgrading
    # your own privacy, not unlocking a paid feature).
    if body.visibility == "private":
        if not has_policy(role, [], "project:set_private", workspace_tier=tier):
            raise HTTPException(
                status_code=403,
                detail="Private projects require innovator tier or above.",
            )

    # Role check — admin+ only for any visibility change.
    if role not in ("admin", "owner"):
        raise HTTPException(
            status_code=403,
            detail="Only workspace admins can change project visibility",
        )

    await async_directus.update_item(
        "project", project_id, {"visibility": body.visibility}
    )
    logger.info(
        f"Project {project_id} visibility: {current} → {body.visibility} "
        f"by {app_user['id']}"
    )
    return {"status": "updated", "visibility": body.visibility}
