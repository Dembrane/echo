"""V2 API middleware: workspace context and permission enforcement."""

from __future__ import annotations

from logging import getLogger
from typing import Optional

from fastapi import Depends, HTTPException

from dembrane.policies import has_policy, meets_tier
from dembrane.app_user import resolve_app_user
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.directus_async import async_directus

logger = getLogger("api.v2.middleware")


class WorkspaceContext:
    """Resolved workspace context for a request.

    Injected via FastAPI Depends. Validates that the authenticated user
    has access to the workspace and provides their role/policies.
    """

    def __init__(
        self,
        workspace_id: str,
        workspace: dict,
        app_user_id: str,
        role: str,
        custom_policies: list[str],
        source: str,
        is_external: bool,
    ):
        self.workspace_id = workspace_id
        self.workspace = workspace
        self.app_user_id = app_user_id
        self.role = role
        self.custom_policies = custom_policies
        self.source = source
        self.is_external = is_external

    def has_policy(self, required: str) -> bool:
        return has_policy(self.role, self.custom_policies, required)

    def require_policy(self, required: str) -> None:
        if not self.has_policy(required):
            raise HTTPException(status_code=403, detail="Access denied")

    def require_tier(self, minimum_tier: str) -> None:
        current = self.workspace.get("tier", "pioneer")
        if not meets_tier(current, minimum_tier):
            raise HTTPException(
                status_code=403,
                detail=f"This feature requires the {minimum_tier} plan or above",
            )


async def get_workspace_context(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> WorkspaceContext:
    """FastAPI dependency that validates workspace access.

    Usage:
        @router.get("/workspaces/{workspace_id}/projects")
        async def list_projects(ctx: WorkspaceContext = Depends(get_workspace_context)):
            ctx.require_policy("project:read")
            ...
    """
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        raise HTTPException(status_code=403, detail="User not onboarded")

    app_user_id = app_user["id"]

    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )

    if not isinstance(memberships, list) or len(memberships) == 0:
        raise HTTPException(status_code=403, detail="No access to this workspace")

    membership = memberships[0]

    # Fetch workspace details
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    return WorkspaceContext(
        workspace_id=workspace_id,
        workspace=workspace,
        app_user_id=app_user_id,
        role=membership["role"],
        custom_policies=membership.get("custom_policies") or [],
        source=membership.get("source", "direct"),
        is_external=membership.get("is_external", False),
    )
