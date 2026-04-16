"""V2 project endpoints — workspace-aware operations."""

from logging import getLogger

from fastapi import APIRouter, HTTPException

from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
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
