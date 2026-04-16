"""Workspace settings: detail, update, members, and invite (from settings)."""

from logging import getLogger
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.workspace_settings")


# ── Detail ──


class WorkspaceMember(BaseModel):
    id: str  # membership id
    user_id: str
    display_name: str
    email: str
    avatar: Optional[str] = None
    role: str
    source: str
    is_external: bool


class WorkspaceDetailResponse(BaseModel):
    id: str
    name: str
    tier: str
    org_id: str
    org_name: str
    is_default: bool
    legal_basis: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    description: Optional[str] = None
    members: list[WorkspaceMember] = []
    pending_invite_count: int = 0


@router.get("/{workspace_id}/settings", response_model=WorkspaceDetailResponse)
async def get_workspace_settings(
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> WorkspaceDetailResponse:
    """Get workspace details + full member list. Requires workspace membership."""
    ws = ctx.workspace

    # Org name
    org_name = ""
    if ws.get("org_id"):
        org = await async_directus.get_item("org", ws["org_id"])
        if org:
            org_name = org.get("name", "")

    # Full member list
    memberships = await async_directus.get_items(
        "workspace_membership",
        {"query": {
            "filter": {"workspace_id": {"_eq": ctx.workspace_id}, "deleted_at": {"_null": True}},
            "fields": ["id", "user_id", "role", "source", "is_external"],
            "limit": -1,
        }},
    )
    members: list[WorkspaceMember] = []
    if isinstance(memberships, list) and len(memberships) > 0:
        user_ids = [m["user_id"] for m in memberships if m.get("user_id")]
        app_users = await async_directus.get_items(
            "app_user",
            {"query": {"filter": {"id": {"_in": user_ids}}, "fields": ["id", "display_name", "email", "directus_user_id"], "limit": -1}},
        )
        user_map = {u["id"]: u for u in (app_users if isinstance(app_users, list) else [])}

        # Fetch avatars
        du_ids = [u["directus_user_id"] for u in user_map.values() if u.get("directus_user_id")]
        avatar_map: dict[str, Optional[str]] = {}
        if du_ids:
            profiles = await async_directus.get_users(
                {"query": {"filter": {"id": {"_in": du_ids}}, "fields": ["id", "avatar"], "limit": -1}},
            )
            if isinstance(profiles, list):
                avatar_map = {u["id"]: u.get("avatar") for u in profiles}

        for m in memberships:
            user = user_map.get(m.get("user_id", ""))
            if not user:
                continue
            members.append(WorkspaceMember(
                id=m["id"],
                user_id=m["user_id"],
                display_name=user.get("display_name", ""),
                email=user.get("email", ""),
                avatar=avatar_map.get(user.get("directus_user_id", "")),
                role=m.get("role", ""),
                source=m.get("source", ""),
                is_external=m.get("is_external", False),
            ))

    # Pending invites count
    pending = await async_directus.get_items(
        "workspace_invite",
        {"query": {
            "filter": {"workspace_id": {"_eq": ctx.workspace_id}, "accepted_at": {"_null": True}},
            "aggregate": {"count": ["id"]},
        }},
    )
    pending_count = 0
    if isinstance(pending, list) and len(pending) > 0:
        pending_count = int(pending[0].get("count", {}).get("id", 0))

    return WorkspaceDetailResponse(
        id=ws["id"],
        name=ws.get("name", ""),
        tier=ws.get("tier", ""),
        org_id=ws.get("org_id", ""),
        org_name=org_name,
        is_default=ws.get("is_default", False),
        legal_basis=ws.get("legal_basis"),
        privacy_policy_url=ws.get("privacy_policy_url"),
        description=ws.get("description"),
        members=members,
        pending_invite_count=pending_count,
    )


# ── Update ──


class UpdateWorkspaceRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


@router.patch("/{workspace_id}/settings")
async def update_workspace_settings(
    body: UpdateWorkspaceRequest,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Update workspace name/description. Requires settings:manage."""
    ctx.require_policy("settings:manage")

    payload = {}
    if body.name is not None:
        payload["name"] = body.name.strip()
    if body.description is not None:
        payload["description"] = body.description.strip()

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("workspace", ctx.workspace_id, payload)
    return {"status": "success"}


# ── Remove member ──


@router.delete("/{workspace_id}/members/{membership_id}")
async def remove_workspace_member(
    membership_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Soft-delete a workspace membership. Requires member:manage."""
    ctx.require_policy("member:manage")

    from datetime import datetime
    await async_directus.update_item(
        "workspace_membership",
        membership_id,
        {"deleted_at": datetime.utcnow().isoformat()},
    )
    return {"status": "success"}
