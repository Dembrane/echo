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
    # Privacy + settings context for the settings page controls.
    # `description` lives above (shared with legacy consumers).
    inherit_team_admins: bool = True
    inherit_team_members: bool = False
    logo_url: Optional[str] = None


@router.get("/{workspace_id}/settings", response_model=WorkspaceDetailResponse)
async def get_workspace_settings(
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> WorkspaceDetailResponse:
    """Get workspace details + full member list.

    Access tiers:
      - Any workspace member can read the workspace info + see names/avatars.
      - Only users with member:manage (admin/owner) see full emails + the
        pending-invite list. External guests and viewers don't.

    Closes the guest-data-leak finding from the 2026-04-21 walkthrough:
    external guests previously saw every member's email and the pending
    invites of their host workspace.
    """
    ws = ctx.workspace
    can_manage = ctx.has_policy("member:manage")

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
            # Email is management-only (guest-data-leak fix). Self-row
            # always shows own email — users already know their own.
            is_self = m.get("user_id") == ctx.app_user_id
            show_email = can_manage or is_self
            members.append(WorkspaceMember(
                id=m["id"],
                user_id=m["user_id"],
                display_name=user.get("display_name", ""),
                email=user.get("email", "") if show_email else "",
                avatar=avatar_map.get(user.get("directus_user_id", "")),
                role=m.get("role", ""),
                source=m.get("source", ""),
                is_external=m.get("is_external", False),
            ))

    # Pending invites — management-only. Emails of not-yet-members aren't
    # anyone else's business.
    pending_invites: list[PendingInvite] = []
    pending_invites_raw: list = []
    if can_manage:
        pending_invites_raw_result = await async_directus.get_items(
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
        if isinstance(pending_invites_raw_result, list):
            pending_invites_raw = pending_invites_raw_result
    if len(pending_invites_raw) > 0:
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
        inherit_team_admins=bool(
            (ws.get("settings") or {}).get("inherit_team_admins", True)
        ) if isinstance(ws.get("settings"), dict) else True,
        inherit_team_members=bool(
            (ws.get("settings") or {}).get("inherit_team_members", False)
        ) if isinstance(ws.get("settings"), dict) else False,
        logo_url=ws.get("logo_url"),
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


# Only http/https logos allowed — blocks javascript:/data:/file:// URIs
# that would turn logo rendering into an XSS or SSRF vector downstream.
_LOGO_URL_SCHEMES = ("http://", "https://")


def _validate_logo_url(value: str) -> str:
    """Normalise + validate a logo URL. Raises HTTPException(400) on reject.

    Accepts absolute http(s) URLs only. Length-capped at 2048 to keep stored
    strings reasonable.
    """
    if value is None:
        return value  # caller should not pass None; noop-safe
    cleaned = value.strip()
    if cleaned == "":
        return ""
    if len(cleaned) > 2048:
        raise HTTPException(status_code=400, detail="Logo URL is too long")
    lower = cleaned.lower()
    if not lower.startswith(_LOGO_URL_SCHEMES):
        raise HTTPException(
            status_code=400, detail="Logo URL must start with http:// or https://"
        )
    return cleaned


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
        # Strip control chars — this value ends up in email subject lines
        # (workspace_added / workspace_invite / upgrade_request).
        payload["name"] = body.name.replace("\r", " ").replace("\n", " ").strip()
    if body.description is not None:
        payload["description"] = body.description.strip()
    if body.logo_url is not None:
        # Whitelabel branding is tier-gated (changemaker+). Changing the
        # workspace logo is whitelabel — gate it here so the tier check
        # happens before the DB write, not only on downgrade.
        cleaned_logo = _validate_logo_url(body.logo_url)
        current_logo = ctx.workspace.get("logo_url") or ""
        if cleaned_logo != current_logo:
            ctx.require_policy("workspace:whitelabel")
        payload["logo_url"] = cleaned_logo or None

    # Privacy flags write into workspace.settings (existing JSON column).
    if body.inherit_team_admins is not None or body.inherit_team_members is not None:
        # Normalise NULL settings (legacy rows) to {} before dict ops.
        current_settings = ctx.workspace.get("settings") or {}
        if not isinstance(current_settings, dict):
            current_settings = {}
        # Setting inherit_team_admins=false makes the workspace private — gated.
        going_private = (
            body.inherit_team_admins is False
            and current_settings.get("inherit_team_admins", True) is not False
        )
        if going_private:
            ctx.require_policy("workspace:set_private")

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

    removed_user_id = membership.get("user_id")
    if removed_user_id and removed_user_id != ctx.app_user_id:
        from dembrane.notifications import emit
        await emit(
            audience_user_id=removed_user_id,
            actor_user_id=ctx.app_user_id,
            event_code="WORKSPACE_REMOVED",
            title=f"You were removed from {ctx.workspace.get('name', 'a workspace')}",
            message="Reach out to the workspace admin if this was unexpected.",
            action="NONE",
            ref_workspace_id=ctx.workspace_id,
        )

    # Sticky-remove: if this user would otherwise re-derive admin/member
    # access via their org role (rule-of-system inheritance), tombstone
    # them so team-role changes don't silently re-grant access. Only
    # applies when the removed user has an active org_membership.
    from dembrane.inheritance import sticky_remove
    if removed_user_id and ctx.workspace.get("org_id"):
        # Check if they'd re-derive via org role — only tombstone if yes.
        org_rows = await async_directus.get_items(
            "org_membership",
            {"query": {"filter": {
                "org_id": {"_eq": ctx.workspace["org_id"]},
                "user_id": {"_eq": removed_user_id},
                "deleted_at": {"_null": True},
            }, "fields": ["role"], "limit": 1}},
        )
        if isinstance(org_rows, list) and org_rows:
            await sticky_remove(
                workspace_id=ctx.workspace_id,
                user_id=removed_user_id,
                by_user_id=ctx.app_user_id,
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

    # Hard rule: an external member can never be admin or owner. Externals
    # are guests — promoting them into management roles mixes access layers
    # that should stay separate. If you want them as admin, add them to the
    # team first, then promote.
    if membership.get("is_external") and body.role in ("admin", "owner"):
        raise HTTPException(
            status_code=400,
            detail=(
                "External members can't be admins or owners. Add them to the "
                "team first (via invite with is_org_member=true), then promote."
            ),
        )

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

    # Notify the affected user (unless they're the one making the change).
    if membership.get("user_id") and membership["user_id"] != ctx.app_user_id:
        from dembrane.notifications import emit
        await emit(
            audience_user_id=membership["user_id"],
            actor_user_id=ctx.app_user_id,
            event_code="WORKSPACE_ROLE_CHANGED",
            title=f"Your role changed in {ctx.workspace.get('name', 'a workspace')}",
            message=f"You're now a **{body.role}** here.",
            action="NAVIGATE_WS",
            ref_workspace_id=ctx.workspace_id,
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

    # Notify the invitee if they already have an app_user account. New-
    # email invites have no in-app target — email would be the only
    # channel and we deliberately don't chase those.
    from dembrane.app_user import resolve_app_user
    invitee_directus = await async_directus.get_users(
        {
            "query": {
                "filter": {"email": {"_eq": (invite.get("email") or "").lower()}},
                "fields": ["id"],
                "limit": 1,
            }
        }
    )
    if isinstance(invitee_directus, list) and invitee_directus:
        invitee_app_user = await resolve_app_user(invitee_directus[0]["id"])
        if invitee_app_user:
            from dembrane.notifications import emit
            await emit(
                audience_user_id=invitee_app_user["id"],
                actor_user_id=ctx.app_user_id,
                event_code="INVITE_CANCELLED",
                title=(
                    f"An invite to {ctx.workspace.get('name', 'a workspace')} "
                    "was cancelled"
                ),
                message="The admin withdrew your pending invite.",
                action="NONE",
                ref_workspace_id=ctx.workspace_id,
                ref_invite_id=invite_id,
            )

    # Hard delete — there's no reason to keep canceled invites around
    await async_directus.delete_item("workspace_invite", invite_id)
    return {"status": "success"}
