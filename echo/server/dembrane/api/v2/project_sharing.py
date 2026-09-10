"""V2 private project sharing — project_membership CRUD.

Implements the backend for the designer's Ask 3 (persistent "Shared with"
strip + "Who can see this project?" modal). Tier-gated at innovator+ via
has_policy's project:share rule.

Private project = project.visibility == 'private'. When visibility is
'workspace', project is visible to every workspace member — project_membership
is irrelevant.

A share only unlocks the private project. What the person can do there is
their workspace role (dembrane.policies.WORKSPACE_ROLE_PRESETS); there is no
separate per-share level.

Endpoints:
  GET    /v2/projects/:id/members          — list current shares
  GET    /v2/projects/:id/invites          — pending workspace invites carrying this project
  POST   /v2/projects/:id/members          — add a share (innovator+)
  DELETE /v2/projects/:id/members/:uid     — revoke share (hard delete)
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger

from fastapi import APIRouter, HTTPException
from pydantic import EmailStr, BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.policies import (
    TIER_REQUIRED_FOR_POLICY,
    has_policy,
    meets_tier,
    role_can_access_projects,
)
from dembrane.inheritance import user_can_access, get_effective_members
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.api.v2._invite_helpers import upsert_project_membership

router = APIRouter()
logger = getLogger("api.v2.project_sharing")

NOT_A_MEMBER = "not_a_member"
ROLE_CANNOT_ACCESS_PROJECTS = "role_cannot_access_projects"


def require_role_can_access_projects(role: str | None) -> None:
    """Sharing with a role that can't open projects (billing) would be a silent no-op."""
    if not role_can_access_projects(role):
        raise HTTPException(
            status_code=400,
            detail={
                "code": ROLE_CANNOT_ACCESS_PROJECTS,
                "message": "Billing members can't open projects. Give them another role first.",
            },
        )


# ── Response shapes ─────────────────────────────────────────────────────


class ProjectShareResponse(BaseModel):
    user_id: str
    email: str
    display_name: str
    avatar: Optional[str] = None
    # The person's workspace role: it decides what they can do on the project.
    workspace_role: Optional[str] = None
    granted_by: Optional[str] = None
    created_at: Optional[str] = None


class ProjectPendingInvite(BaseModel):
    id: str
    email: str
    role: str  # workspace role granted on accept; the share level follows it
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


class AddShareRequest(BaseModel):
    email: EmailStr


# ── Helpers ─────────────────────────────────────────────────────────────


async def _get_project(project_id: str) -> dict:
    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def require_private_project(project: dict) -> None:
    """Shares only exist on private projects; workspace-visible ones need no share."""
    if project.get("visibility") != "private":
        raise HTTPException(
            status_code=400,
            detail=(
                "This project is visible to the whole workspace. "
                "Mark it private before adding individual shares."
            ),
        )


async def _resolve_share_admin(
    project: dict, acting_app_user_id: str
) -> tuple[dict, bool]:
    """Resolve (workspace, tier_allows_sharing) for a caller of the share APIs.

    Raises on the access and admin checks, but returns the tier gate rather
    than raising it, so a read-only caller (the pending-invites list) can
    degrade to an empty answer instead of erroring. Checking the role before
    the tier keeps a non-admin a 403 even on a lapsed workspace.
    """
    workspace_id = project.get("workspace_id")
    if not workspace_id:
        raise HTTPException(
            status_code=400,
            detail="Project is not attached to a workspace",
        )

    resolved = await user_can_access(workspace_id, acting_app_user_id)
    if resolved is None:
        raise HTTPException(status_code=403, detail="No access to this project")
    role, _ = resolved

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Role first, with no tier passed so has_policy skips its tier gate.
    if not has_policy(role, [], "project:share"):
        raise HTTPException(
            status_code=403, detail="Only workspace admins can share projects"
        )

    from dembrane.billing_account import resolve_workspace_tier

    tier = (await resolve_workspace_tier(workspace_id)) or "pioneer"
    required_tier = TIER_REQUIRED_FOR_POLICY.get("project:share", "innovator")
    return workspace, meets_tier(tier, required_tier)


async def _require_share_admin(project: dict, acting_app_user_id: str) -> dict:
    """_resolve_share_admin with the tier gate raised as a 403."""
    workspace, tier_ok = await _resolve_share_admin(project, acting_app_user_id)
    if not tier_ok:
        required_tier = TIER_REQUIRED_FOR_POLICY.get("project:share", "innovator")
        raise HTTPException(
            status_code=403,
            detail=(
                f"Private project sharing requires the {required_tier} plan or above."
            ),
        )
    return workspace


async def _enrich_member(
    row: dict, workspace_role: Optional[str]
) -> Optional[ProjectShareResponse]:
    """Turn a project_membership row into the response shape by joining
    app_user + directus_users for display_name/email/avatar."""
    uid = row.get("user_id")
    if not uid:
        return None

    app_user = await async_directus.get_item("app_user", uid)
    if not app_user:
        return None

    du_id = app_user.get("directus_user_id")
    avatar = None
    if du_id:
        du_rows = await async_directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_eq": du_id}},
                    "fields": ["avatar"],
                    "limit": 1,
                }
            }
        )
        if isinstance(du_rows, list) and du_rows:
            avatar = du_rows[0].get("avatar")

    return ProjectShareResponse(
        user_id=uid,
        email=app_user.get("email") or "",
        display_name=app_user.get("display_name") or "",
        avatar=avatar,
        workspace_role=workspace_role,
        granted_by=row.get("granted_by"),
        created_at=row.get("created_at"),
    )


# ── Endpoints ───────────────────────────────────────────────────────────


@router.get("/{project_id}/members", response_model=list[ProjectShareResponse])
async def list_project_shares(
    project_id: str,
    auth: DependencyDirectusSession,
) -> list[ProjectShareResponse]:
    """List everyone the project is explicitly shared with.

    Access rules (round-2 audit, F5):
      - Workspace admin/owner sees full email + display_name + avatar.
      - Non-admin workspace members: email is hidden when project is
        private (unless the reader is themselves on the share list).
      - visibility='workspace' (public to the workspace): full detail
        for any workspace member, since this isn't a sensitive list.

    No workspace access at all → 403. Missing project_id → 400 at
    _get_project.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    project = await _get_project(project_id)

    workspace_id = project.get("workspace_id")
    if not workspace_id:
        raise HTTPException(
            status_code=400,
            detail="Project is not attached to a workspace",
        )

    resolved = await user_can_access(workspace_id, app_user["id"])
    if resolved is None:
        raise HTTPException(status_code=403, detail="No access to this project")
    reader_role, _ = resolved
    reader_is_admin = reader_role in ("admin", "owner")
    is_private = project.get("visibility") == "private"

    rows = await async_directus.get_items(
        "project_membership",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}},
                "fields": ["user_id", "granted_by", "created_at"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(rows, list):
        return []

    # One resolution for the whole workspace instead of a lookup per share.
    ws_roles = {m["user_id"]: m["role"] for m in await get_effective_members(workspace_id)}

    out: list[ProjectShareResponse] = []
    for row in rows:
        ws_role = ws_roles.get(row.get("user_id"))
        if ws_role is None:
            continue  # stale share for someone no longer on the workspace
        enriched = await _enrich_member(row, ws_role)
        if not enriched:
            continue
        # Hide email from non-admin readers on private projects, unless
        # the reader is themselves one of the shared users (they've
        # already seen their own email in /v2/me).
        if is_private and not reader_is_admin and enriched.user_id != app_user["id"]:
            enriched.email = ""
        out.append(enriched)
    return out


@router.get("/{project_id}/invites", response_model=list[ProjectPendingInvite])
async def list_project_pending_invites(
    project_id: str,
    auth: DependencyDirectusSession,
) -> list[ProjectPendingInvite]:
    """Pending workspace invites that will share this project on accept.

    Admin-only (project:share), since the rows carry emails of people who
    aren't on the workspace yet.
    """
    from datetime import datetime, timezone

    acting_user = await get_app_user_or_raise(auth.user_id)
    project = await _get_project(project_id)
    # Lapsed tier: the Access tab polls this, so answer empty instead of a 403
    # storm. A non-admin still gets the 403 from _resolve_share_admin.
    workspace, tier_ok = await _resolve_share_admin(project, acting_user["id"])
    if not tier_ok:
        return []

    now_iso = datetime.now(timezone.utc).isoformat()
    rows = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "workspace_id": {"_eq": workspace["id"]},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id", "email", "role", "created_at", "expires_at"],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [
        ProjectPendingInvite(
            id=r["id"],
            email=r.get("email") or "",
            role=r.get("role") or "member",
            created_at=r.get("created_at"),
            expires_at=r.get("expires_at"),
        )
        for r in rows
    ]


@router.post("/{project_id}/members", response_model=ProjectShareResponse)
async def add_project_share(
    project_id: str,
    body: AddShareRequest,
    auth: DependencyDirectusSession,
) -> ProjectShareResponse:
    """Share a private project with a specific workspace member.

    Constraints (Ask 3 modal copy: "only people already in this workspace
    — no cross-workspace sharing"):
      1. Project must be visibility='private'.
      2. Invitee must already be a workspace member (direct or derived).
      3. Caller must have project:share policy (admin role) AND tier
         must meet innovator+.
    """
    acting_user = await get_app_user_or_raise(auth.user_id)
    project = await _get_project(project_id)
    require_private_project(project)
    workspace = await _require_share_admin(project, acting_user["id"])

    # Find the invitee's app_user (via email).
    email = body.email.strip().lower()
    app_users = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"email": {"_eq": email}},
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    # Structured detail so the sharing modal can offer a workspace invite
    # instead of a dead-end toast (POST /v2/workspaces/:id/invite with project_id).
    if not isinstance(app_users, list) or not app_users:
        raise HTTPException(
            status_code=404,
            detail={
                "code": NOT_A_MEMBER,
                "message": "That email isn't on this workspace. Invite them to the workspace first.",
            },
        )
    invitee_id = app_users[0]["id"]

    # Invitee must have workspace access. No cross-workspace sharing.
    invitee_access = await user_can_access(workspace["id"], invitee_id)
    if not invitee_access:
        raise HTTPException(
            status_code=404,
            detail={
                "code": NOT_A_MEMBER,
                "message": "That person isn't in this workspace. Invite them first.",
            },
        )

    invitee_ws_role = invitee_access[0]
    require_role_can_access_projects(invitee_ws_role)
    outcome = await upsert_project_membership(
        async_directus,
        project_id=project_id,
        user_id=invitee_id,
        granted_by=acting_user["id"],
    )
    logger.info(f"{outcome} project {project_id} share: {invitee_id} by {acting_user['id']}")

    # Notify the invitee — they now have access to a project they
    # didn't before. Skip when they're re-granting themselves (shouldn't
    # happen given the admin-only guard above, defense-in-depth).
    if outcome == "created" and invitee_id != acting_user["id"]:
        project_name = project.get("name") or "a project"
        from dembrane.notifications import emit
        await emit(
            audience_user_id=invitee_id,
            actor_user_id=acting_user["id"],
            event_code="PROJECT_SHARE_ADDED",
            title=f"{project_name} was shared with you",
            message=(
                f"You now have access to this project in "
                f"{workspace.get('name', 'its workspace')}."
            ),
            action="NAVIGATE_PROJECT",
            ref_project_id=project_id,
            ref_workspace_id=workspace["id"],
        )

    enriched = await _enrich_member(
        {"user_id": invitee_id, "granted_by": acting_user["id"]},
        invitee_ws_role,
    )
    # _enrich_member only returns None when the app_user row vanishes — since
    # we just verified it via email lookup, enriched is non-None here.
    assert enriched is not None
    return enriched


@router.delete("/{project_id}/members/{user_id}")
async def revoke_project_share(
    project_id: str,
    user_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Revoke a project share. Hard-delete — the project_membership row
    doesn't have a deleted_at field, and the designer's share modal has
    no "undo remove" affordance. Re-grant is explicit via POST.
    """
    acting_user = await get_app_user_or_raise(auth.user_id)
    project = await _get_project(project_id)
    await _require_share_admin(project, acting_user["id"])

    rows = await async_directus.get_items(
        "project_membership",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "user_id": {"_eq": user_id},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=404, detail="Share not found")

    await async_directus.delete_item("project_membership", rows[0]["id"])
    logger.info(
        f"Revoked project {project_id} share for {user_id} by {acting_user['id']}"
    )

    if user_id != acting_user["id"]:
        project_name = project.get("name") or "a project"
        from dembrane.notifications import emit
        await emit(
            audience_user_id=user_id,
            actor_user_id=acting_user["id"],
            event_code="PROJECT_SHARE_REVOKED",
            title=f"Your access to {project_name} was revoked",
            message="Ask the project owner if you still need access.",
            action="NONE",
            ref_project_id=project_id,
            ref_workspace_id=project.get("workspace_id"),
        )

    return {"status": "revoked"}
