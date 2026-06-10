"""POST /v2/workspaces/:id/invite — invite a user to a workspace."""

from __future__ import annotations

import hmac
import hashlib
from typing import Annotated
from logging import getLogger
from datetime import datetime, timezone, timedelta

from fastapi import Depends, APIRouter, HTTPException

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user
from dembrane.policies import ROLE_HIERARCHY
from dembrane.settings import get_settings
from dembrane.seat_capacity import assert_can_add_seat
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.schemas import WorkspaceInviteRequest, WorkspaceInviteResponse
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context

router = APIRouter()
logger = getLogger("api.v2.invites")


DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]

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
) -> bool:
    """Returns False on broker failure so callers can set email_sent=False."""
    from dembrane.tasks import task_send_invite_email

    try:
        task_send_invite_email.send(to, subject, template, template_data, failure_context)
        return True
    except Exception:
        logger.exception(f"Couldn't enqueue invite email for {to} ({failure_context})")
        return False


@router.post("/{workspace_id}/invite", response_model=WorkspaceInviteResponse)
async def invite_to_workspace(
    workspace_id: str,
    body: WorkspaceInviteRequest,
    ctx: DependencyWorkspaceContext,
) -> WorkspaceInviteResponse:
    """Invite a user to a workspace by email.

    `role` is the single axis. role='external' invites an outside
    collaborator and skips the org_membership write. Any other role
    writes (or reuses) an org_membership row in this workspace's org
    before creating the workspace_membership. Invariant per ADR-0003:
    role='external' ⟺ no org_membership row for the user in this org;
    enforced at write-time only, no read-time derivation.

    If the user already has a Directus account + app_user:
      → Create workspace_membership immediately (status: "added")

    If the user doesn't exist:
      → Create workspace_invite with token
      → Send invite email via SendGrid
      → On register + onboard the invite is auto-accepted (status: "invited")
    """
    ctx.require_policy("member:invite")

    email = body.email.strip().lower()
    role = body.role
    is_external_invite = role == "external"

    # Role-escalation guard: caller can only grant roles at or below their
    # own level. external sits at the bottom (0) so anyone with
    # member:invite can grant it. owner (4) is currently never grantable
    # via this endpoint because no caller can ever exceed their own
    # level — the workspace creator is the only owner, and they cannot
    # grant owner to anyone else through invite.
    inviter_level = ROLE_HIERARCHY.get(ctx.role, 0)
    requested_level = ROLE_HIERARCHY.get(role, 0)
    if requested_level > inviter_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    # Prevent self-invite
    inviter_app_user = await async_directus.get_items(
        "app_user",
        {"query": {"filter": {"id": {"_eq": ctx.app_user_id}}, "fields": ["email"], "limit": 1}},
    )
    if isinstance(inviter_app_user, list) and len(inviter_app_user) > 0:
        if inviter_app_user[0].get("email", "").lower() == email:
            raise HTTPException(status_code=400, detail="Cannot invite yourself")

    # Rate-limit after validation gates so spam on malformed/forbidden requests doesn't burn legitimate quota.
    await _invite_rate_limiter.check(ctx.app_user_id)

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
            # Include soft-deleted rows so we reactivate rather than insert a duplicate.
            existing_membership_rows = await async_directus.get_items(
                "workspace_membership",
                {
                    "query": {
                        "filter": {
                            "workspace_id": {"_eq": workspace_id},
                            "user_id": {"_eq": app_user["id"]},
                        },
                        "fields": ["id", "deleted_at", "role"],
                        "limit": 1,
                    }
                },
            )
            existing_row = (
                existing_membership_rows[0]
                if isinstance(existing_membership_rows, list) and existing_membership_rows
                else None
            )

            # Idempotent re-invite: active member → 200 already_member, no email. Must run before the seat-cap gate.
            if existing_row and not existing_row.get("deleted_at"):
                # Best-effort cleanup of stale pending invite rows for the same (email, workspace).
                try:
                    now_iso = datetime.now(timezone.utc).isoformat()
                    stale = await async_directus.get_items(
                        "workspace_invite",
                        {
                            "query": {
                                "filter": {
                                    "workspace_id": {"_eq": workspace_id},
                                    "email": {"_eq": email},
                                    "accepted_at": {"_null": True},
                                    "deleted_at": {"_null": True},
                                },
                                "fields": ["id"],
                                "limit": -1,
                            }
                        },
                    )
                    if isinstance(stale, list):
                        for inv in stale:
                            await async_directus.update_item(
                                "workspace_invite",
                                inv["id"],
                                {"accepted_at": now_iso},
                            )
                except Exception:
                    logger.exception(
                        "already_member: failed to clean up stale pending invites "
                        "for %s in workspace %s",
                        email,
                        workspace_id,
                    )

                return WorkspaceInviteResponse(
                    status="already_member",
                    email=email,
                    user_existed=True,
                    email_sent=False,
                )

            # Net-new seat or reactivation of soft-deleted row: include pending invites in the cap.
            await assert_can_add_seat(
                ctx.workspace, audience="admin", include_pending=True
            )

            ws_org_id = ctx.workspace.get("org_id")

            # Invariant: role='external' ⟺ no org_membership in this org. Non-external invites create org_membership if missing (also the external-to-member promotion path).
            newly_joined_organisation = False
            if not is_external_invite and ws_org_id:
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
                    from dembrane.api.v2._invite_helpers import create_membership_row

                    newly_joined_organisation = await create_membership_row(
                        async_directus,
                        "org_membership",
                        {
                            "id": generate_uuid(),
                            "org_id": ws_org_id,
                            "user_id": app_user["id"],
                            "role": "member",
                        },
                    )
                    if newly_joined_organisation:
                        logger.info(f"Added {email} to org {ws_org_id} as member")

            # External add: enforce insider XOR outsider before creating the
            # external row (removes a stale org_membership, or rejects if the
            # user is already an internal member of this org).
            if is_external_invite and ws_org_id:
                from dembrane.api.v2._invite_helpers import (
                    reconcile_external_membership_org_row,
                )

                await reconcile_external_membership_org_row(ws_org_id, app_user["id"])

            # Reactivate a soft-deleted row if present; otherwise create fresh. Distinct status so UI can show "reactivated" vs "added".
            from dembrane.api.v2._invite_helpers import (
                create_membership_row,
                reactivate_membership_row,
            )

            reactivated = False
            if existing_row and existing_row.get("deleted_at"):
                reactivated = await reactivate_membership_row(
                    async_directus,
                    "workspace_membership",
                    existing_row["id"],
                    {"deleted_at": None, "role": role, "source": "direct"},
                )
            else:
                await create_membership_row(
                    async_directus,
                    "workspace_membership",
                    {
                        "id": generate_uuid(),
                        "workspace_id": workspace_id,
                        "user_id": app_user["id"],
                        "role": role,
                        "source": "direct",
                    },
                )

            from dembrane.cache_utils import invalidate_workspace_and_org_usage

            await invalidate_workspace_and_org_usage(workspace_id, ws_org_id)

            logger.info(
                f"Added {email} to workspace {workspace_id} as {role} by {ctx.app_user_id}"
            )

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

            # WORKSPACE_GUEST_ADDED → workspace admins/owners when an
            # external collaborator joins. (Event code retained for
            # backwards-compatible notification stream; the user-facing
            # copy uses "external".)
            if is_external_invite:
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_workspace_admins,
                )

                admin_ids = await audience_workspace_admins(workspace_id)
                admin_ids = [a for a in admin_ids if a != ctx.app_user_id and a != app_user["id"]]
                external_name = app_user.get("display_name") or email or "An external"
                ws_name = ctx.workspace.get("name", "your workspace")
                await emit_to_audience(
                    admin_ids,
                    actor_user_id=ctx.app_user_id,
                    event_code="WORKSPACE_GUEST_ADDED",
                    title=f"{external_name} joined {ws_name} as an external",
                    message=(
                        f"{email} now has external access. Externals count "
                        "against your tier's seat cap."
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

            email_queued = _enqueue_invite_email(
                to=email,
                subject=f"You've been added to {ctx.workspace.get('name', 'a workspace')}",
                template="workspace_added",
                template_data={
                    "inviter_name": inviter_name,
                    "workspace_name": ctx.workspace.get("name", "a workspace"),
                    "invite_url": f"{settings.urls.admin_base_url}/w/{workspace_id}/projects",
                },
                failure_context=f"workspace_added / workspace {workspace_id}",
            )

            return WorkspaceInviteResponse(
                status="reactivated" if reactivated else "added",
                email=email,
                user_existed=True,
                email_sent=email_queued,
            )

    # User doesn't exist or doesn't have app_user — create an invite.
    # Pending invites reserve seats elsewhere, so cap-check before issuing one.
    await assert_can_add_seat(ctx.workspace, audience="admin", include_pending=True)

    expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()

    now_iso = datetime.now(timezone.utc).isoformat()
    existing_invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "email": {"_eq": email},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )

    if isinstance(existing_invites, list) and len(existing_invites) > 0:
        # 200 with status string so the modal renders this per-row rather than as a global failure.
        return WorkspaceInviteResponse(
            status="already_invited",
            email=email,
            user_existed=user_existed,
            email_sent=False,
        )

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
        },
    )

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

    email_queued = _enqueue_invite_email(
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
        f"(user_existed: {user_existed}, email_queued: {email_queued})"
    )

    return WorkspaceInviteResponse(
        status="invited",
        email=email,
        user_existed=user_existed,
        email_sent=email_queued,
    )
