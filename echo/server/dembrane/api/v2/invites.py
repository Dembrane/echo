"""POST /v2/workspaces/:id/invite — invite a user to a workspace."""

from __future__ import annotations

import hmac
import hashlib
from logging import getLogger
from datetime import datetime, timezone, timedelta

from fastapi import Depends, APIRouter, HTTPException

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user
from dembrane.settings import get_settings
from dembrane.seat_capacity import assert_can_add_guest, assert_can_add_member
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.schemas import WorkspaceInviteRequest, WorkspaceInviteResponse
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context

router = APIRouter()
logger = getLogger("api.v2.invites")

settings = get_settings()
_invite_rate_limiter = create_user_rate_limiter(
    name="workspace_invite", capacity=20, window_seconds=3600
)


def compute_invite_hash(invite_id: str) -> str:
    """HMAC-SHA256(invite_id, directus_secret) truncated to 16 bytes / 32 hex chars.

    Used in email URLs as an opaque pointer — unforgeable without the server
    secret, can't be reversed to find the invite_id, safe to log.
    """
    secret = settings.directus.secret.encode()
    full = hmac.new(secret, invite_id.encode(), hashlib.sha256).hexdigest()
    return full[:32]


def _enqueue_invite_email(
    *,
    to: str,
    subject: str,
    template: str,
    template_data: dict,
    failure_context: str,
) -> None:
    """Queue an invite email on the Dramatiq network queue.

    Lives here (not in tasks.py) only for the one-line enqueue wrapper —
    the actor itself is `task_send_invite_email` in tasks.py. Keeping the
    caller-side import lazy avoids pulling Dramatiq into the request path
    at module load (the broker connects on first .send()).
    """
    from dembrane.tasks import task_send_invite_email

    try:
        task_send_invite_email.send(to, subject, template, template_data, failure_context)
    except Exception:
        # If Redis / the broker is down, log and move on — the membership
        # / invite row is already written, so the admin can resend later.
        logger.exception(f"Couldn't enqueue invite email for {to} ({failure_context})")


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

    if role not in ("admin", "member", "billing"):
        raise HTTPException(status_code=400, detail="Role must be admin, member, or billing")

    # Prevent role escalation — can only grant roles at or below your own level.
    # Billing sits between member and admin: it's more than a member (financial
    # visibility) but less than an admin (no project or content control).
    ROLE_HIERARCHY = {"member": 1, "billing": 2, "admin": 3, "owner": 4}
    inviter_level = ROLE_HIERARCHY.get(ctx.role, 0)
    requested_level = ROLE_HIERARCHY.get(role, 0)
    if requested_level > inviter_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    # Hard rule: externals (guests — non-organisation members on a workspace) can
    # only ever be member. Admin/owner/billing roles imply management or
    # financial responsibility that doesn't make sense for a guest of
    # another organisation. If the caller isn't inviting this person as a organisation
    # member (is_org_member=false), clamp to member.
    if not body.is_org_member and role in ("admin", "owner", "billing"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Guests can't be admins, owners, or billing. "
                "Invite them as a organisation member first, or choose member."
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

    # Seat / guest cap gate. "Gate the host, not the invitee" — block the
    # invite from being sent rather than letting an invitee click a link
    # only to hit a wall. include_pending=True so outstanding
    # workspace_invite rows count too — without this an admin at 0/2
    # could fire 5 guest invites and only 2 would actually succeed at
    # accept-time, leaving 3 invitees with friendly-but-confusing 402s.
    # assert_can_add_* is still a no-op on tiers that allow overage
    # (Pioneer+ for member seats), unlimited tiers (Guardian), and
    # unknown legacy tiers.
    if body.is_org_member:
        await assert_can_add_member(
            ctx.workspace, audience="admin", include_pending=True
        )
    else:
        await assert_can_add_guest(
            ctx.workspace, audience="admin", include_pending=True
        )

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
            # whether we freshly added them so the ORGANISATION_MEMBER_ADDED
            # notification only fires for genuinely new organisation joiners.
            newly_joined_organisation = False
            if body.is_org_member and ws_org_id:
                existing_org_mem = await async_directus.get_items(
                    "org_membership",
                    {
                        "query": {
                            "filter": {
                                "org_id": {"_eq": ws_org_id},
                                "user_id": {"_eq": app_user["id"]},
                                "deleted_at": {"_null": True},
                            },
                            "limit": 1,
                        }
                    },
                )
                if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
                    await async_directus.create_item(
                        "org_membership",
                        {
                            "id": generate_uuid(),
                            "org_id": ws_org_id,
                            "user_id": app_user["id"],
                            "role": "member",
                        },
                    )
                    logger.info(f"Added {email} to org {ws_org_id} as member")
                    newly_joined_organisation = True

            await async_directus.create_item(
                "workspace_membership",
                {
                    "id": generate_uuid(),
                    "workspace_id": workspace_id,
                    "user_id": app_user["id"],
                    "role": role,
                    "source": "direct",
                    "is_external": is_external,
                },
            )

            # Bust cached usage so seat / guest counts refresh on next read.
            # Bust BOTH layers — workspace-scope and org-scope — since the
            # /v2/orgs/:id/usage rollup aggregates over every workspace and
            # would otherwise stay stale for up to USAGE_TTL_SECONDS.
            from dembrane.cache_utils import invalidate_workspace_and_org_usage

            await invalidate_workspace_and_org_usage(workspace_id, ws_org_id)

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
                message=(f"You were added to **{ctx.workspace.get('name', '')}** as {role}."),
                action="NAVIGATE_WS",
                ref_workspace_id=workspace_id,
                ref_org_id=ws_org_id,
            )

            # ORGANISATION_MEMBER_ADDED to organisation admins when the invitee is new
            # to the organisation. Kept out of the workspace-only path (they're
            # still a guest there, no organisation-roster change to announce).
            if newly_joined_organisation and ws_org_id:
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_organisation_admins,
                )

                organisation_admin_ids = await audience_organisation_admins(ws_org_id)
                organisation_row = await async_directus.get_item("org", ws_org_id)
                organisation_name = (organisation_row or {}).get("name") or "the organisation"
                new_member_name = app_user.get("display_name") or email or "A new member"
                await emit_to_audience(
                    organisation_admin_ids,
                    actor_user_id=ctx.app_user_id,
                    event_code="ORGANISATION_MEMBER_ADDED",
                    title=f"{new_member_name} joined {organisation_name}",
                    message="They're now a organisation member.",
                    action="NAVIGATE_ORGANISATION_SETTINGS",
                    ref_org_id=ws_org_id,
                )

            # WORKSPACE_GUEST_ADDED → workspace admins/owners when a guest
            # joins. Guests don't trigger ORGANISATION_MEMBER_ADDED (they're
            # not org members), so without this branch admins never hear
            # about them. Excludes the inviter (they already know) and the
            # invitee themselves.
            if is_external:
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_workspace_admins,
                )

                admin_ids = await audience_workspace_admins(workspace_id)
                admin_ids = [a for a in admin_ids if a != ctx.app_user_id and a != app_user["id"]]
                guest_name = app_user.get("display_name") or email or "A guest"
                ws_name = ctx.workspace.get("name", "your workspace")
                await emit_to_audience(
                    admin_ids,
                    actor_user_id=ctx.app_user_id,
                    event_code="WORKSPACE_GUEST_ADDED",
                    title=f"{guest_name} joined {ws_name} as a guest",
                    message=(
                        f"{email} now has guest access. Guests count against your tier's guest cap."
                    ),
                    action="NAVIGATE_WORKSPACE_SETTINGS",
                    ref_workspace_id=workspace_id,
                    ref_org_id=ws_org_id,
                )

            # Send a notification email
            inviter_name = "Your organisation"
            try:
                inviter_data = await async_directus.get_item("app_user", ctx.app_user_id)
                if inviter_data:
                    inviter_name = inviter_data.get("display_name") or "Your organisation"
            except Exception:
                pass

            _enqueue_invite_email(
                to=email,
                subject=f"You've been added to {ctx.workspace.get('name', 'a workspace')}",
                template="workspace_added",
                template_data={
                    "inviter_name": inviter_name,
                    "workspace_name": ctx.workspace.get("name", "a workspace"),
                    "invite_url": f"{settings.urls.admin_base_url}/workspaces",
                },
                failure_context=f"workspace_added / workspace {workspace_id}",
            )

            return WorkspaceInviteResponse(
                status="added",
                email=email,
                user_existed=True,
                # email_sent here means "queued for send" — the actor
                # reports its own success/failure via logs + Sentry.
                email_sent=True,
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
    inviter_name = "Your organisation"
    inviter_app_user_data = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_eq": ctx.app_user_id}},
                "fields": ["display_name"],
                "limit": 1,
            }
        },
    )
    if isinstance(inviter_app_user_data, list) and len(inviter_app_user_data) > 0:
        inviter_name = inviter_app_user_data[0].get("display_name") or "Your organisation"

    invite_id = generate_uuid()
    await async_directus.create_item(
        "workspace_invite",
        {
            "id": invite_id,
            "workspace_id": workspace_id,
            "email": email,
            "role": role,
            "invited_by": ctx.app_user_id,
            "expires_at": expires_at,
            "include_org_membership": body.is_org_member,
        },
    )

    # Email URL: HMAC hash is the pointer to the invite (opaque, unforgeable),
    # iss/ws/role/email are display-only context. Security = email ownership +
    # HMAC. The `email` param lets the registration form pre-fill the field
    # and lock it, so an invitee can't accidentally sign up with a typo'd
    # address that wouldn't match the invite at acceptance time.
    from urllib.parse import urlencode

    invite_hash = compute_invite_hash(invite_id)
    ctx_params = urlencode(
        {
            "iss": inviter_name,
            "ws": ctx.workspace.get("name", ""),
            "role": role,
            "email": email,
            "h": invite_hash,
        }
    )
    invite_url = f"{settings.urls.admin_base_url}/invite/accept?{ctx_params}"

    _enqueue_invite_email(
        to=email,
        subject=f"{inviter_name} invited you to collaborate on dembrane",
        template="workspace_invite",
        template_data={
            "inviter_name": inviter_name,
            "workspace_name": ctx.workspace.get("name", "a workspace"),
            "invite_url": invite_url,
        },
        failure_context=f"workspace_invite / workspace {workspace_id}",
    )

    logger.info(
        f"Invited {email} to workspace {workspace_id} as {role} by {ctx.app_user_id} "
        f"(user_existed: {user_existed}, email_queued: True)"
    )

    return WorkspaceInviteResponse(
        status="invited",
        email=email,
        user_existed=user_existed,
        # email_sent=True means "queued"; actor logs + Sentry cover the
        # actual SendGrid outcome.
        email_sent=True,
    )
