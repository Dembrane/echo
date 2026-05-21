"""POST /v2/onboarding/complete — one-time user onboarding.

Creates app_user, auto-accepts pending workspace invites, and conditionally
creates a personal org + default workspace based on invite context.

Decision tree:
  1. Create app_user (always)
  2. Auto-accept pending workspace invites (if any)
     - role != 'external' → also add to that org (skip personal org)
     - role == 'external' → external access only
  3. Has own projects OR no internal invites?
     → Create personal org + default workspace + move projects
  4. Only has internal invites (no projects)?
     → Skip personal org (they belong to the inviter's org)
"""

from __future__ import annotations

from logging import getLogger
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from dembrane.utils import generate_uuid
from dembrane.app_user import create_app_user, resolve_app_user, get_directus_user_profile
from dembrane.seat_capacity import assert_can_add_seat
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.schemas import OnboardingCompleteRequest, OnboardingCompleteResponse
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.onboarding")
_onboarding_rate_limiter = create_user_rate_limiter(
    name="onboarding", capacity=5, window_seconds=3600
)


@router.post("/complete", response_model=OnboardingCompleteResponse)
async def complete_onboarding(
    body: OnboardingCompleteRequest,
    auth: DependencyDirectusSession,
) -> OnboardingCompleteResponse:
    """Complete user onboarding. Idempotent — safe to call multiple times."""
    await _onboarding_rate_limiter.check(auth.user_id)
    directus_user_id = auth.user_id
    org_name = body.org_name.strip()

    if not org_name:
        raise HTTPException(status_code=400, detail="Organization name is required")

    # ── Step 1: Get or create app_user ──

    app_user = await resolve_app_user(directus_user_id)

    if not app_user:
        profile = await get_directus_user_profile(directus_user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Directus user not found")

        try:
            app_user = await create_app_user(
                directus_user_id=directus_user_id,
                email=profile.get("email", ""),
                display_name=profile.get("display_name", ""),
            )
            logger.info(f"Created app_user {app_user['id']} for directus user {directus_user_id}")
        except Exception:
            # Race condition: another request created it first. Retry resolve.
            app_user = await resolve_app_user(directus_user_id)
            if not app_user:
                raise HTTPException(
                    status_code=500, detail="Failed to create user profile"
                ) from None

    app_user_id = app_user["id"]
    app_user_email = (app_user.get("email") or "").lower()  # invites stored lowercased

    # ── Step 2: Auto-accept pending workspace invites ──

    now = datetime.now(timezone.utc).isoformat()
    joined_an_org = False
    # Distinct from joined_an_org: tracks whether the user picked up *any*
    # workspace_membership during auto-accept, including guest (external)
    # rows. The personal-org gate below uses this so a user whose only
    # invites were guest invites doesn't get a stray personal organisation —
    # matrix §4 says guests have no team-level presence at all.
    joined_any_workspace = False
    # Tracks whether the user *had* a valid pending invite at signup, even
    # if we couldn't honour it right now (cap reached). The personal-org
    # gate uses this so a blocked invite doesn't trigger a stray personal
    # organisation — the user's intent was to join someone else's setup,
    # and creating a parallel personal organisation while their invite is
    # still pending creates confusing dual-presence state.
    had_pending_invite = False
    first_workspace_id = None

    pending_invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "email": {"_eq": app_user_email},
                    "accepted_at": {"_null": True},
                    "expires_at": {"_gt": now},
                },
                "fields": [
                    "id",
                    "workspace_id",
                    "role",
                    "expires_at",
                    "invited_by",
                ],
                "limit": -1,
            }
        },
    )

    if isinstance(pending_invites, list):
        for invite in pending_invites:
            ws_id = invite.get("workspace_id")
            if not ws_id:
                continue

            # Check workspace exists and get its org
            ws = await async_directus.get_item("workspace", ws_id)
            if not ws or ws.get("deleted_at"):
                continue

            # Mark "had a valid pending invite" before the cap check —
            # so a blocked invite still suppresses the personal-org branch.
            had_pending_invite = True

            invite_role = invite.get("role") or "member"
            ws_org_id = ws.get("org_id")

            existing_org_mem = []
            if ws_org_id:
                existing_org_mem = await async_directus.get_items(
                    "org_membership",
                    {
                        "query": {
                            "filter": {
                                "org_id": {"_eq": ws_org_id},
                                "user_id": {"_eq": app_user_id},
                                "deleted_at": {"_null": True},
                            },
                            "limit": 1,
                        }
                    },
                )
            user_has_org_mem = isinstance(existing_org_mem, list) and len(existing_org_mem) > 0

            # ADR-0003 invariant: external ⇔ no org_membership. Promote to
            # member if the user is already in this workspace's org.
            if invite_role == "external" and user_has_org_mem:
                logger.info(
                    f"Promoting external invite {invite.get('id')} to member: "
                    f"{app_user_email} already in org {ws_org_id}"
                )
                invite_role = "member"

            is_external = invite_role == "external"
            is_org_invite = not is_external

            existing_ws_mem = await async_directus.get_items(
                "workspace_membership",
                {
                    "query": {
                        "filter": {
                            "workspace_id": {"_eq": ws_id},
                            "user_id": {"_eq": app_user_id},
                            "deleted_at": {"_null": True},
                        },
                        "limit": 1,
                    }
                },
            )
            has_ws_mem = isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0

            # Cap gate only when adding a new seat — skip on retries so an
            # over-cap workspace doesn't 402 an existing member.
            if not has_ws_mem:
                try:
                    await assert_can_add_seat(ws, audience="invitee")
                except HTTPException as cap_err:
                    if cap_err.status_code != 402:
                        raise
                    logger.warning(
                        f"Skipping auto-accept of invite {invite.get('id')} "
                        f"for {app_user_email} → workspace {ws_id}: "
                        f"cap reached ({cap_err.detail})"
                    )
                    inviter_id = invite.get("invited_by")
                    ws_name = ws.get("name") or "the workspace"
                    from dembrane.notifications import emit

                    if inviter_id and inviter_id != app_user_id:
                        try:
                            await emit(
                                audience_user_id=inviter_id,
                                actor_user_id=app_user_id,
                                event_code="INVITE_BLOCKED_AT_CAP",
                                title=f"Invite to {ws_name} couldn't be honoured",
                                message=(
                                    f"{app_user_email} signed up but your workspace is at its "
                                    "seat limit. Free a seat or upgrade so they can join."
                                ),
                                action="NAVIGATE_WORKSPACE_SETTINGS",
                                ref_workspace_id=ws_id,
                                ref_org_id=ws_org_id,
                            )
                        except Exception:
                            logger.exception("Failed to emit INVITE_BLOCKED_AT_CAP")

                    try:
                        await emit(
                            audience_user_id=app_user_id,
                            actor_user_id=inviter_id,
                            event_code="INVITE_PENDING_AT_CAP",
                            title=f"Your invite to {ws_name} is still pending",
                            message=(
                                "The workspace is at its seat limit. "
                                "We've notified the admin. Once they free a seat or "
                                "upgrade, you can join from your invites."
                            ),
                            action="NAVIGATE_INVITE",
                            ref_workspace_id=ws_id,
                            ref_org_id=ws_org_id,
                        )
                    except Exception:
                        logger.exception("Failed to emit INVITE_PENDING_AT_CAP")
                    continue

            # If org member invite, add to that org
            if is_org_invite and ws_org_id:
                if not user_has_org_mem:
                    await async_directus.create_item(
                        "org_membership",
                        {
                            "id": generate_uuid(),
                            "org_id": ws_org_id,
                            "user_id": app_user_id,
                            "role": "member",
                        },
                    )
                    logger.info(f"Auto-added {app_user_email} to org {ws_org_id} via invite")
                joined_an_org = True

            # Create workspace membership
            if not has_ws_mem:
                await async_directus.create_item(
                    "workspace_membership",
                    {
                        "id": generate_uuid(),
                        "workspace_id": ws_id,
                        "user_id": app_user_id,
                        "role": invite_role,
                        "source": "direct",
                    },
                )
                from dembrane.cache_utils import invalidate_workspace_and_org_usage

                await invalidate_workspace_and_org_usage(ws_id, ws_org_id)
                joined_any_workspace = True
                logger.info(
                    f"Auto-accepted invite: {app_user_email} → workspace {ws_id} "
                    f"(role: {invite_role})"
                )

            if not first_workspace_id:
                first_workspace_id = ws_id
            # Idempotent re-run: existing membership still suppresses the
            # personal-org branch below.
            joined_any_workspace = True

            # Mark invite as accepted
            await async_directus.update_item(
                "workspace_invite",
                invite["id"],
                {
                    "accepted_at": now,
                },
            )

            # Notify the inviter (INVITE_ACCEPTED #3). Mirrors the
            # notification fired by me.accept_my_invite — same event
            # so the inviter sees a consistent inbox row regardless of
            # how the invitee accepted.
            inviter_id = invite.get("invited_by")
            if inviter_id and inviter_id != app_user_id:
                from dembrane.notifications import emit

                display = (
                    (await get_directus_user_profile(directus_user_id) or {}).get("display_name")
                    or app_user_email
                    or "Someone"
                )
                await emit(
                    audience_user_id=inviter_id,
                    actor_user_id=app_user_id,
                    event_code="INVITE_ACCEPTED",
                    title=f"{display} joined {ws.get('name', 'your workspace')}",
                    message="They accepted your invite and can now collaborate.",
                    action="NAVIGATE_WORKSPACE_SETTINGS",
                    ref_workspace_id=ws_id,
                    ref_org_id=ws.get("org_id"),
                )

            # Notify organisation admins when a new person joins the organisation
            # (ORGANISATION_MEMBER_ADDED #16). Only fires when the invite
            # included an org_membership grant AND the user didn't
            # already belong to the organisation.
            if (
                is_org_invite
                and ws.get("org_id")
                and not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0)
            ):
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_organisation_admins,
                )

                organisation_admins = await audience_organisation_admins(ws["org_id"])
                # Skip the actor (inviter) — they already know.
                organisation_row = await async_directus.get_item("org", ws["org_id"])
                organisation_name = (organisation_row or {}).get("name") or "the organisation"
                new_member_name = (
                    (await get_directus_user_profile(directus_user_id) or {}).get("display_name")
                    or app_user_email
                    or "A new member"
                )
                await emit_to_audience(
                    organisation_admins,
                    actor_user_id=inviter_id,
                    event_code="ORGANISATION_MEMBER_ADDED",
                    title=f"{new_member_name} joined {organisation_name}",
                    message="They're now a organisation member.",
                    action="NAVIGATE_ORGANISATION_SETTINGS",
                    ref_org_id=ws["org_id"],
                )

            # WORKSPACE_GUEST_ADDED → workspace admins when the auto-accept
            # creates a guest membership. Mirrors the notification on the
            # me.py accept paths so admins see guest joins regardless of
            # whether the invitee came through onboarding or the inbox.
            if is_external:
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_workspace_admins,
                )

                admin_ids = await audience_workspace_admins(ws_id)
                admin_ids = [a for a in admin_ids if a != app_user_id and a != inviter_id]
                external_name = (
                    (await get_directus_user_profile(directus_user_id) or {}).get("display_name")
                    or app_user_email
                    or "An external"
                )
                ws_name = ws.get("name") or "your workspace"
                await emit_to_audience(
                    admin_ids,
                    actor_user_id=app_user_id,
                    event_code="WORKSPACE_GUEST_ADDED",
                    title=f"{external_name} joined {ws_name} as an external",
                    message=(
                        f"{app_user_email} now has external access. "
                        "Externals count against your tier's seat cap."
                    ),
                    action="NAVIGATE_WORKSPACE_SETTINGS",
                    ref_workspace_id=ws_id,
                    ref_org_id=ws.get("org_id"),
                )

    # ── Step 3: Check if user has their own projects ──

    user_projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "directus_user_id": {"_eq": directus_user_id},
                    "workspace_id": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    has_own_projects = isinstance(user_projects, list) and len(user_projects) > 0

    # ── Step 4: Decide whether to create personal org + workspace ──
    #
    # Create personal org if:
    #   - User has their own projects (need somewhere to put them), OR
    #   - User has NO inbound invite of any kind — truly new signup, they
    #     need their own organisation to do anything useful.
    # Skip personal org if:
    #   - User joined an org via invite (joined_an_org), OR
    #   - User joined any workspace at all, including as a guest, OR
    #   - User had a pending invite that we couldn't honour right now
    #     (cap reached). Matrix §4 + product call 2026-05-04: the user's
    #     intent was to join someone else's setup. Spinning up a parallel
    #     personal organisation while their invite is still pending
    #     creates a confusing dual-presence state where they're both
    #     "admin of their own org" and "waiting to join the inviter's
    #     org" — surfaces a bogus "Manage organisation" + Add-workspace
    #     surface they didn't ask for. Once admin frees a seat, the
    #     pending invite can still be accepted via /me/invites.

    org_id = None
    workspace_id = first_workspace_id  # default to first invited workspace

    needs_personal_org = has_own_projects or (
        not joined_an_org and not joined_any_workspace and not had_pending_invite
    )

    if needs_personal_org:
        # Check if already has a personal org
        existing_orgs = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "role": {"_eq": "owner"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["org_id"],
                    "limit": 1,
                }
            },
        )

        if isinstance(existing_orgs, list) and len(existing_orgs) > 0:
            org_id = existing_orgs[0]["org_id"]
        else:
            org_id = generate_uuid()
            await async_directus.create_item(
                "org",
                {
                    "id": org_id,
                    "name": org_name,
                    "created_by": app_user_id,
                },
            )
            await async_directus.create_item(
                "org_membership",
                {
                    "id": generate_uuid(),
                    "org_id": org_id,
                    "user_id": app_user_id,
                    "role": "owner",
                },
            )
            logger.info(f"Created personal org {org_id} '{org_name}' for {app_user_email}")

        # Create default workspace in personal org
        existing_ws = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "is_default": {"_eq": True},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )

        if isinstance(existing_ws, list) and len(existing_ws) > 0:
            personal_ws_id = existing_ws[0]["id"]
        else:
            personal_ws_id = generate_uuid()
            # System-seeded workspace — bypasses workspace_request flow intentionally.
            # Only user-initiated workspace creation goes through requests.
            await async_directus.create_item(
                "workspace",
                {
                    "id": personal_ws_id,
                    "org_id": org_id,
                    "name": "Default",
                    "is_default": True,
                    "tier": "free",
                    "created_by": app_user_id,
                },
            )
            logger.info(f"Created default workspace {personal_ws_id} for org {org_id}")

        # Make sure the creator has a workspace_membership — even when
        # the workspace row already existed (e.g. an earlier onboarding
        # attempt crashed after creating the workspace but before the
        # membership row was written). This is the idempotent repair
        # for partial-state users who otherwise see "No workspaces yet"
        # on /w forever. Pains doc entry: [block] 2026-04-23.
        existing_self_mem = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": personal_ws_id},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not (isinstance(existing_self_mem, list) and len(existing_self_mem) > 0):
            from dembrane.inheritance import on_workspace_created

            await on_workspace_created(
                workspace_id=personal_ws_id,
                creator_app_user_id=app_user_id,
            )

        # Move user's orphaned projects into the personal workspace
        if has_own_projects:
            all_projects = await async_directus.get_items(
                "project",
                {
                    "query": {
                        "filter": {
                            "directus_user_id": {"_eq": directus_user_id},
                            "workspace_id": {"_null": True},
                        },
                        "fields": ["id"],
                        "limit": -1,
                    }
                },
            )
            moved = 0
            if isinstance(all_projects, list):
                for p in all_projects:
                    await async_directus.update_item(
                        "project",
                        p["id"],
                        {
                            "workspace_id": personal_ws_id,
                        },
                    )
                    moved += 1
            if moved > 0:
                logger.info(f"Moved {moved} projects into workspace {personal_ws_id}")

        workspace_id = personal_ws_id

    return OnboardingCompleteResponse(
        app_user_id=app_user_id,
        org_id=org_id or "",
        workspace_id=workspace_id or "",
    )
