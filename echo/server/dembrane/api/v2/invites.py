"""POST /v2/workspaces/:id/invite — invite a user to a workspace."""

from __future__ import annotations

import hmac
import hashlib
from logging import getLogger
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from dembrane.api.rate_limit import create_user_rate_limiter

from dembrane.utils import generate_uuid
from dembrane.email import send_email
from dembrane.app_user import resolve_app_user
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import WorkspaceInviteRequest, WorkspaceInviteResponse
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.settings import get_settings

router = APIRouter()
logger = getLogger("api.v2.invites")

settings = get_settings()
_invite_rate_limiter = create_user_rate_limiter(name="workspace_invite", capacity=20, window_seconds=3600)


def compute_invite_hash(invite_id: str) -> str:
    """HMAC-SHA256(invite_id, directus_secret) truncated to 16 bytes / 32 hex chars.

    Used in email URLs as an opaque pointer — unforgeable without the server
    secret, can't be reversed to find the invite_id, safe to log.
    """
    secret = settings.directus.secret.encode()
    full = hmac.new(secret, invite_id.encode(), hashlib.sha256).hexdigest()
    return full[:32]


@router.post("/{workspace_id}/invite", response_model=WorkspaceInviteResponse)
async def invite_to_workspace(
    workspace_id: str,
    body: WorkspaceInviteRequest,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> WorkspaceInviteResponse:
    """Invite a user to a workspace by email.

    If the user already has a Directus account + app_user:
      → Create workspace_membership immediately (status: "added")

    If the user doesn't exist:
      → Create workspace_invite with token
      → Send invite email via SendGrid
      → When they register + onboard, the invite is auto-accepted (status: "invited")
    """
    ctx.require_policy("member:invite")

    await _invite_rate_limiter.check(ctx.app_user_id)

    email = body.email.strip().lower()
    role = body.role

    if role not in ("admin", "member", "viewer"):
        raise HTTPException(status_code=400, detail="Role must be admin, member, or viewer")

    # Prevent role escalation — can only grant roles at or below your own level
    ROLE_HIERARCHY = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}
    inviter_level = ROLE_HIERARCHY.get(ctx.role, 0)
    requested_level = ROLE_HIERARCHY.get(role, 0)
    if requested_level > inviter_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    # Hard rule: externals (non-team members on a workspace) can only ever be
    # member or viewer. Owner/admin roles imply management responsibility,
    # which doesn't make sense for a guest of another team. If the caller
    # isn't inviting this person as a team member (is_org_member=false),
    # clamp to member max.
    if not body.is_org_member and role in ("admin", "owner"):
        raise HTTPException(
            status_code=400,
            detail=(
                "External members can't be admins or owners. "
                "Invite them as a team member first, or choose member/viewer."
            ),
        )

    # Prevent self-invite
    inviter_app_user = await async_directus.get_items(
        "app_user",
        {"query": {"filter": {"id": {"_eq": ctx.app_user_id}}, "fields": ["email"], "limit": 1}},
    )
    if isinstance(inviter_app_user, list) and len(inviter_app_user) > 0:
        if inviter_app_user[0].get("email", "").lower() == email:
            raise HTTPException(status_code=400, detail="Cannot invite yourself")

    # Check if already a member
    existing_membership = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id"],
                "limit": -1,
            }
        },
    )

    # Try to find the user
    users = await async_directus.get_users(
        {
            "query": {
                "filter": {"email": {"_eq": email}},
                "fields": ["id", "email", "first_name", "last_name"],
                "limit": 1,
            }
        },
    )

    user_existed = isinstance(users, list) and len(users) > 0

    if user_existed:
        directus_user = users[0]

        # Check if they have an app_user
        app_user = await resolve_app_user(directus_user["id"])

        if app_user:
            # Check if already a member
            if isinstance(existing_membership, list):
                for m in existing_membership:
                    if m.get("user_id") == app_user["id"]:
                        raise HTTPException(
                            status_code=409,
                            detail="User is already a member of this workspace",
                        )

            # Determine external status based on invite intent
            is_external = not body.is_org_member
            ws_org_id = ctx.workspace.get("org_id")

            # If marked as org member, add them to the org too. Track
            # whether we freshly added them so the TEAM_MEMBER_ADDED
            # notification only fires for genuinely new team joiners.
            newly_joined_team = False
            if body.is_org_member and ws_org_id:
                existing_org_mem = await async_directus.get_items(
                    "org_membership",
                    {"query": {"filter": {
                        "org_id": {"_eq": ws_org_id},
                        "user_id": {"_eq": app_user["id"]},
                        "deleted_at": {"_null": True},
                    }, "limit": 1}},
                )
                if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
                    await async_directus.create_item("org_membership", {
                        "id": generate_uuid(),
                        "org_id": ws_org_id,
                        "user_id": app_user["id"],
                        "role": "member",
                    })
                    logger.info(f"Added {email} to org {ws_org_id} as member")
                    newly_joined_team = True

            await async_directus.create_item("workspace_membership", {
                "id": generate_uuid(),
                "workspace_id": workspace_id,
                "user_id": app_user["id"],
                "role": role,
                "source": "direct",
                "is_external": is_external,
            })

            logger.info(
                f"Added {email} to workspace {workspace_id} as {role} "
                f"(external: {is_external}) by {ctx.app_user_id}"
            )

            # Notify the invitee in-app so they see the new workspace
            # on their next page load without having to wait for the
            # email to land.
            from dembrane.notifications import emit
            await emit(
                audience_user_id=app_user["id"],
                actor_user_id=ctx.app_user_id,
                event_code="WORKSPACE_ADDED",
                title=f"You're in {ctx.workspace.get('name', 'a workspace')}",
                message=(
                    f"You were added to **{ctx.workspace.get('name', '')}** "
                    f"as {role}."
                ),
                action="NAVIGATE_WS",
                ref_workspace_id=workspace_id,
                ref_org_id=ws_org_id,
            )

            # TEAM_MEMBER_ADDED to team admins when the invitee is new
            # to the team. Kept out of the workspace-only path (they're
            # still a guest there, no team-roster change to announce).
            if newly_joined_team and ws_org_id:
                from dembrane.notifications import (
                    audience_team_admins,
                    emit_to_audience,
                )
                team_admin_ids = await audience_team_admins(ws_org_id)
                team_row = await async_directus.get_item("org", ws_org_id)
                team_name = (team_row or {}).get("name") or "the team"
                new_member_name = (
                    app_user.get("display_name") or email or "A new member"
                )
                await emit_to_audience(
                    team_admin_ids,
                    actor_user_id=ctx.app_user_id,
                    event_code="TEAM_MEMBER_ADDED",
                    title=f"{new_member_name} joined {team_name}",
                    message="They're now a team member.",
                    action="NAVIGATE_TEAM_SETTINGS",
                    ref_org_id=ws_org_id,
                )

            # Send a notification email
            inviter_name = "Your team"
            try:
                inviter_data = await async_directus.get_item("app_user", ctx.app_user_id)
                if inviter_data:
                    inviter_name = inviter_data.get("display_name") or "Your team"
            except Exception:
                pass

            email_sent = await send_email(
                to=email,
                subject=f"You've been added to {ctx.workspace.get('name', 'a workspace')}",
                template="workspace_added",
                template_data={
                    "inviter_name": inviter_name,
                    "workspace_name": ctx.workspace.get("name", "a workspace"),
                    "invite_url": f"{settings.urls.admin_base_url}/workspaces",
                },
            )
            if not email_sent:
                logger.error(
                    f"Failed to send workspace_added email to {email} for workspace {workspace_id}"
                )
                try:
                    import sentry_sdk
                    sentry_sdk.capture_message(
                        f"Workspace add email failed: {email} / workspace {workspace_id}",
                        level="error",
                    )
                except Exception:
                    pass

            return WorkspaceInviteResponse(
                status="added",
                email=email,
                user_existed=True,
                email_sent=email_sent,
            )

    # User doesn't exist or doesn't have app_user — create an invite.
    # Security via HMAC hash derived from invite_id — no stored token needed.
    expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()

    # Check for existing pending invite (not accepted AND not expired)
    now_iso = datetime.now(timezone.utc).isoformat()
    existing_invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "email": {"_eq": email},
                    "accepted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )

    if isinstance(existing_invites, list) and len(existing_invites) > 0:
        raise HTTPException(status_code=409, detail="An invite is already pending for this email")

    # Get inviter name
    inviter_name = "Your team"
    inviter_app_user_data = await async_directus.get_items(
        "app_user",
        {"query": {"filter": {"id": {"_eq": ctx.app_user_id}}, "fields": ["display_name"], "limit": 1}},
    )
    if isinstance(inviter_app_user_data, list) and len(inviter_app_user_data) > 0:
        inviter_name = inviter_app_user_data[0].get("display_name") or "Your team"

    invite_id = generate_uuid()
    await async_directus.create_item("workspace_invite", {
        "id": invite_id,
        "workspace_id": workspace_id,
        "email": email,
        "role": role,
        "invited_by": ctx.app_user_id,
        "expires_at": expires_at,
        "include_org_membership": body.is_org_member,
    })

    # Email URL: HMAC hash is the pointer to the invite (opaque, unforgeable),
    # iss/ws/role are display-only context. Security = email ownership + HMAC.
    from urllib.parse import urlencode
    invite_hash = compute_invite_hash(invite_id)
    ctx_params = urlencode({
        "iss": inviter_name,
        "ws": ctx.workspace.get("name", ""),
        "role": role,
        "h": invite_hash,
    })
    invite_url = f"{settings.urls.admin_base_url}/invite/accept?{ctx_params}"

    email_sent = await send_email(
        to=email,
        subject=f"{inviter_name} invited you to collaborate on dembrane",
        template="workspace_invite",
        template_data={
            "inviter_name": inviter_name,
            "workspace_name": ctx.workspace.get("name", "a workspace"),
            "invite_url": invite_url,
        },
    )
    if not email_sent:
        logger.error(
            f"Failed to send workspace_invite email to {email} for workspace {workspace_id}"
        )
        try:
            import sentry_sdk
            sentry_sdk.capture_message(
                f"Workspace invite email failed: {email} / workspace {workspace_id}",
                level="error",
            )
        except Exception:
            pass

    logger.info(
        f"Invited {email} to workspace {workspace_id} as {role} by {ctx.app_user_id} "
        f"(user_existed: {user_existed}, email_sent: {email_sent})"
    )

    return WorkspaceInviteResponse(
        status="invited",
        email=email,
        user_existed=user_existed,
        email_sent=email_sent,
    )
