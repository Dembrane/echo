"""Workspace settings: detail, update, members, and invite (from settings)."""

from logging import getLogger
from typing import Optional
from datetime import datetime, timezone

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


class PendingInvite(BaseModel):
    id: str
    email: str
    role: str
    created_at: Optional[str] = None
    invited_by_name: Optional[str] = None
    expires_at: Optional[str] = None


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
    pending_invites: list[PendingInvite] = []
    # Current user's access
    my_role: str = ""
    my_policies: list[str] = []


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

    # Pending invites
    pending_invites_raw = await async_directus.get_items(
        "workspace_invite",
        {"query": {
            "filter": {
                "workspace_id": {"_eq": ctx.workspace_id},
                "accepted_at": {"_null": True},
                "expires_at": {"_gt": datetime.now(timezone.utc).isoformat()},
            },
            "fields": ["id", "email", "role", "created_at", "invited_by", "expires_at"],
            "sort": ["-created_at"],
            "limit": 50,
        }},
    )
    pending_invites: list[PendingInvite] = []
    if isinstance(pending_invites_raw, list) and len(pending_invites_raw) > 0:
        # Resolve inviter names
        inviter_ids = list({inv.get("invited_by") for inv in pending_invites_raw if inv.get("invited_by")})
        inviter_name_map: dict[str, str] = {}
        if inviter_ids:
            inviters = await async_directus.get_items(
                "app_user",
                {"query": {
                    "filter": {"id": {"_in": inviter_ids}},
                    "fields": ["id", "display_name"],
                    "limit": -1,
                }},
            )
            if isinstance(inviters, list):
                inviter_name_map = {u["id"]: u.get("display_name") or "" for u in inviters}

        pending_invites = [
            PendingInvite(
                id=inv["id"],
                email=inv.get("email", ""),
                role=inv.get("role", ""),
                created_at=inv.get("created_at"),
                invited_by_name=inviter_name_map.get(inv.get("invited_by", "")) or None,
                expires_at=inv.get("expires_at"),
            )
            for inv in pending_invites_raw
        ]

    # Current user's effective policies — expand "*" into all known policies
    from dembrane.policies import get_effective_policies, WORKSPACE_ROLE_PRESETS
    effective = get_effective_policies(ctx.role, ctx.custom_policies, WORKSPACE_ROLE_PRESETS)
    if "*" in effective:
        # Owner gets all policies — show them explicitly instead of "*"
        all_policies = set()
        for preset_policies in WORKSPACE_ROLE_PRESETS.values():
            for p in preset_policies:
                if p != "*":
                    all_policies.add(p)
        effective = sorted(all_policies)

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
        pending_invites=pending_invites,
        my_role=ctx.role,
        my_policies=effective,
    )


# ── Update ──


class UpdateWorkspaceRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    logo_url: Optional[str] = None
    # Privacy flags — wizard step 2 equivalents. Flipping true→false makes
    # the workspace private; derivation stops on next access check.
    # Flipping false→true re-enables team-admin derivation (subject to the
    # per-user sticky_removed tombstones).
    inherit_team_admins: Optional[bool] = None
    inherit_team_members: Optional[bool] = None


@router.patch("/{workspace_id}/settings")
async def update_workspace_settings(
    body: UpdateWorkspaceRequest,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Update workspace name/description/logo/privacy flags.

    Requires settings:manage. Making a workspace private is tier-gated at
    innovator+ via has_policy's workspace:set_private rule.
    """
    ctx.require_policy("settings:manage")

    payload: dict = {}
    if body.name is not None:
        payload["name"] = body.name.strip()
    if body.description is not None:
        payload["description"] = body.description.strip()
    if body.logo_url is not None:
        payload["logo_url"] = body.logo_url

    # Privacy flags write into workspace.settings (existing JSON column).
    if body.inherit_team_admins is not None or body.inherit_team_members is not None:
        # Setting inherit_team_admins=false makes the workspace private — gated.
        going_private = (
            body.inherit_team_admins is False
            and ctx.workspace.get("settings", {}) .get("inherit_team_admins", True) is not False
        )
        if going_private:
            ctx.require_policy("workspace:set_private")

        current_settings = ctx.workspace.get("settings") or {}
        if not isinstance(current_settings, dict):
            current_settings = {}
        merged = dict(current_settings)
        if body.inherit_team_admins is not None:
            merged["inherit_team_admins"] = bool(body.inherit_team_admins)
        if body.inherit_team_members is not None:
            merged["inherit_team_members"] = bool(body.inherit_team_members)
        payload["settings"] = merged

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

    membership = await async_directus.get_item("workspace_membership", membership_id)
    if not membership or membership.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Membership not found in this workspace")
    if membership.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Membership already removed")

    if membership.get("role") == "owner":
        owners = await async_directus.get_items(
            "workspace_membership",
            {"query": {"filter": {
                "workspace_id": {"_eq": ctx.workspace_id},
                "role": {"_eq": "owner"},
                "deleted_at": {"_null": True},
            }, "fields": ["id"], "limit": 2}},
        )
        if isinstance(owners, list) and len(owners) <= 1:
            raise HTTPException(status_code=400, detail="Cannot remove the last owner. Transfer ownership first.")

    await async_directus.update_item(
        "workspace_membership",
        membership_id,
        {"deleted_at": datetime.now(timezone.utc).isoformat()},
    )
    return {"status": "success"}


# ── Change member role ──


ROLE_HIERARCHY = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


class ChangeRoleRequest(BaseModel):
    role: str


@router.patch("/{workspace_id}/members/{membership_id}")
async def change_member_role(
    membership_id: str,
    body: ChangeRoleRequest,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Change a member's role. Requires member:manage."""
    ctx.require_policy("member:manage")

    if body.role not in ("viewer", "member", "admin", "owner"):
        raise HTTPException(status_code=400, detail="Invalid role")

    # Prevent escalation — can only set roles at or below your own level
    caller_level = ROLE_HIERARCHY.get(ctx.role, 0)
    requested_level = ROLE_HIERARCHY.get(body.role, 0)
    if requested_level > caller_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    membership = await async_directus.get_item("workspace_membership", membership_id)
    if not membership or membership.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Membership not found in this workspace")
    if membership.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Membership already removed")

    # Prevent demoting the last owner
    if membership.get("role") == "owner" and body.role != "owner":
        owners = await async_directus.get_items(
            "workspace_membership",
            {"query": {"filter": {
                "workspace_id": {"_eq": ctx.workspace_id},
                "role": {"_eq": "owner"},
                "deleted_at": {"_null": True},
            }, "fields": ["id"], "limit": 2}},
        )
        if isinstance(owners, list) and len(owners) <= 1:
            raise HTTPException(status_code=400, detail="Cannot demote the last owner. Promote someone else first.")

    await async_directus.update_item(
        "workspace_membership",
        membership_id,
        {"role": body.role},
    )
    return {"status": "success"}


# ── Cancel pending invite ──


@router.post("/{workspace_id}/invites/{invite_id}/resend")
async def resend_workspace_invite(
    invite_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Resend a pending invite email. Extends expiration by 7 days."""
    ctx.require_policy("member:invite")

    from datetime import timedelta
    from dembrane.email import send_email
    from dembrane.settings import get_settings
    settings = get_settings()

    invite = await async_directus.get_item("workspace_invite", invite_id)
    if not invite or invite.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Invite not found in this workspace")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite has already been accepted")

    # Extend expiration by 7 days
    new_expires = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    await async_directus.update_item(
        "workspace_invite",
        invite_id,
        {"expires_at": new_expires},
    )

    # Get inviter name
    inviter_name = "Your team"
    try:
        inviter = await async_directus.get_item("app_user", ctx.app_user_id)
        if inviter and inviter.get("display_name"):
            inviter_name = inviter["display_name"]
    except Exception:
        pass

    # Build invite URL with HMAC hash + display context
    from dembrane.api.v2.invites import compute_invite_hash
    from urllib.parse import urlencode
    invite_hash = compute_invite_hash(invite_id)
    ctx_params = urlencode({
        "iss": inviter_name,
        "ws": ctx.workspace.get("name", ""),
        "role": invite.get("role", "member"),
        "h": invite_hash,
    })
    invite_url = f"{settings.urls.admin_base_url}/invite/accept?{ctx_params}"
    email_sent = await send_email(
        to=invite["email"],
        subject=f"{inviter_name} invited you to collaborate on dembrane",
        template="workspace_invite",
        template_data={
            "inviter_name": inviter_name,
            "workspace_name": ctx.workspace.get("name", "a workspace"),
            "invite_url": invite_url,
        },
    )
    if not email_sent:
        logger.error(f"Failed to resend invite email to {invite['email']}")

    return {"status": "success", "email_sent": email_sent}


@router.delete("/{workspace_id}/invites/{invite_id}")
async def cancel_workspace_invite(
    invite_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    """Cancel a pending invite. Requires member:invite."""
    ctx.require_policy("member:invite")

    invite = await async_directus.get_item("workspace_invite", invite_id)
    if not invite or invite.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Invite not found in this workspace")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite has already been accepted")

    # Hard delete — there's no reason to keep canceled invites around
    await async_directus.delete_item("workspace_invite", invite_id)
    return {"status": "success"}
