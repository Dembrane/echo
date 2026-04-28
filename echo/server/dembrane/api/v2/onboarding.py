"""POST /v2/onboarding/complete — one-time user onboarding.

Creates app_user, auto-accepts pending workspace invites, and conditionally
creates a personal org + default workspace based on invite context.

Decision tree:
  1. Create app_user (always)
  2. Auto-accept pending workspace invites (if any)
     - include_org_membership=true → also add to that org (skip personal org)
     - include_org_membership=false → external access only
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
from dembrane.app_user import resolve_app_user, create_app_user, get_directus_user_profile
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import OnboardingCompleteRequest, OnboardingCompleteResponse
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.api.rate_limit import create_user_rate_limiter

router = APIRouter()
logger = getLogger("api.v2.onboarding")
_onboarding_rate_limiter = create_user_rate_limiter(name="onboarding", capacity=5, window_seconds=3600)


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
                raise HTTPException(status_code=500, detail="Failed to create user profile")

    app_user_id = app_user["id"]
    app_user_email = (app_user.get("email") or "").lower()  # invites stored lowercased

    # ── Step 2: Auto-accept pending workspace invites ──

    now = datetime.now(timezone.utc).isoformat()
    joined_an_org = False
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
                    "id", "workspace_id", "role",
                    "include_org_membership", "expires_at",
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

            is_org_invite = invite.get("include_org_membership", False)
            is_external = not is_org_invite

            # If org member invite, add to that org
            if is_org_invite and ws.get("org_id"):
                org_id = ws["org_id"]
                existing_org_mem = await async_directus.get_items(
                    "org_membership",
                    {"query": {"filter": {
                        "org_id": {"_eq": org_id},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    }, "limit": 1}},
                )
                if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
                    await async_directus.create_item("org_membership", {
                        "id": generate_uuid(),
                        "org_id": org_id,
                        "user_id": app_user_id,
                        "role": "member",
                    })
                    logger.info(f"Auto-added {app_user_email} to org {org_id} via invite")
                joined_an_org = True

            # Create workspace membership
            existing_ws_mem = await async_directus.get_items(
                "workspace_membership",
                {"query": {"filter": {
                    "workspace_id": {"_eq": ws_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                }, "limit": 1}},
            )
            if not (isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0):
                await async_directus.create_item("workspace_membership", {
                    "id": generate_uuid(),
                    "workspace_id": ws_id,
                    "user_id": app_user_id,
                    "role": invite.get("role", "member"),
                    "source": "direct",
                    "is_external": is_external,
                })
                logger.info(
                    f"Auto-accepted invite: {app_user_email} → workspace {ws_id} "
                    f"(role: {invite.get('role')}, external: {is_external})"
                )

            if not first_workspace_id:
                first_workspace_id = ws_id

            # Mark invite as accepted
            await async_directus.update_item("workspace_invite", invite["id"], {
                "accepted_at": now,
            })

            # Notify the inviter (INVITE_ACCEPTED #3). Mirrors the
            # notification fired by me.accept_my_invite — same event
            # so the inviter sees a consistent inbox row regardless of
            # how the invitee accepted.
            inviter_id = invite.get("invited_by")
            if inviter_id and inviter_id != app_user_id:
                from dembrane.notifications import emit
                display = (
                    (await get_directus_user_profile(directus_user_id) or {})
                    .get("display_name") or app_user_email or "Someone"
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

            # Notify team admins when a new person joins the team
            # (TEAM_MEMBER_ADDED #16). Only fires when the invite
            # included an org_membership grant AND the user didn't
            # already belong to the team.
            if is_org_invite and ws.get("org_id") and not (
                isinstance(existing_org_mem, list) and len(existing_org_mem) > 0
            ):
                from dembrane.notifications import (
                    audience_team_admins,
                    emit_to_audience,
                )
                team_admins = await audience_team_admins(ws["org_id"])
                # Skip the actor (inviter) — they already know.
                team_row = await async_directus.get_item("org", ws["org_id"])
                team_name = (team_row or {}).get("name") or "the team"
                new_member_name = (
                    (await get_directus_user_profile(directus_user_id) or {})
                    .get("display_name") or app_user_email or "A new member"
                )
                await emit_to_audience(
                    team_admins,
                    actor_user_id=inviter_id,
                    event_code="TEAM_MEMBER_ADDED",
                    title=f"{new_member_name} joined {team_name}",
                    message="They're now a team member.",
                    action="NAVIGATE_TEAM_SETTINGS",
                    ref_org_id=ws["org_id"],
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
    #   - User has their own projects (need somewhere to put them)
    #   - User has NO internal org invites (they need their own org)
    # Skip personal org if:
    #   - User joined an org via invite AND has no projects of their own

    org_id = None
    workspace_id = first_workspace_id  # default to first invited workspace

    needs_personal_org = has_own_projects or not joined_an_org

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
            await async_directus.create_item("org", {
                "id": org_id,
                "name": org_name,
                "created_by": app_user_id,
            })
            await async_directus.create_item("org_membership", {
                "id": generate_uuid(),
                "org_id": org_id,
                "user_id": app_user_id,
                "role": "owner",
            })
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
            await async_directus.create_item("workspace", {
                "id": personal_ws_id,
                "org_id": org_id,
                "name": "Default",
                "is_default": True,
                "tier": "pilot",
                "created_by": app_user_id,
            })
            logger.info(f"Created default workspace {personal_ws_id} for org {org_id}")

        # Make sure the creator has a workspace_membership — even when
        # the workspace row already existed (e.g. an earlier onboarding
        # attempt crashed after creating the workspace but before the
        # membership row was written). This is the idempotent repair
        # for partial-state users who otherwise see "No workspaces yet"
        # on /w forever. Pains doc entry: [block] 2026-04-23.
        existing_self_mem = await async_directus.get_items(
            "workspace_membership",
            {"query": {"filter": {
                "workspace_id": {"_eq": personal_ws_id},
                "user_id": {"_eq": app_user_id},
                "deleted_at": {"_null": True},
            }, "limit": 1}},
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
                    await async_directus.update_item("project", p["id"], {
                        "workspace_id": personal_ws_id,
                    })
                    moved += 1
            if moved > 0:
                logger.info(f"Moved {moved} projects into workspace {personal_ws_id}")

        workspace_id = personal_ws_id

    return OnboardingCompleteResponse(
        app_user_id=app_user_id,
        org_id=org_id or "",
        workspace_id=workspace_id or "",
    )
