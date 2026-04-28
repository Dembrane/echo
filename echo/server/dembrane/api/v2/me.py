"""GET /v2/me — lightweight user profile with onboarding status."""

from logging import getLogger
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from dembrane.app_user import resolve_app_user, get_directus_user_profile, get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import MeResponse, OrgSummary
from dembrane.api.v2.invites import compute_invite_hash
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.api.rate_limit import create_user_rate_limiter

router = APIRouter()
logger = getLogger("api.v2.me")

_accept_rate_limiter = create_user_rate_limiter(name="invite_accept", capacity=30, window_seconds=3600)

_ROLE_LEVEL = {"member": 1, "billing": 2, "admin": 3, "owner": 4}


@router.get("", response_model=MeResponse)
async def get_me(auth: DependencyDirectusSession) -> MeResponse:
    """Lightweight user profile with onboarding status, org memberships,
    and pending invite check."""

    app_user = await resolve_app_user(auth.user_id)
    directus_profile = await get_directus_user_profile(auth.user_id)

    if not directus_profile:
        logger.warning(f"Directus user not found for id {auth.user_id}")
        return MeResponse(
            directus_user_id=auth.user_id,
            email="",
            display_name="",
            onboarding_completed=False,
            is_staff=bool(auth.is_admin),
        )

    email = directus_profile.get("email", "")

    # Check for pending workspace invites (by email, regardless of onboarding)
    has_pending_invites = False
    if email:
        pending = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": email},
                        "accepted_at": {"_null": True},
                        "expires_at": {"_gt": datetime.now(timezone.utc).isoformat()},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        has_pending_invites = isinstance(pending, list) and len(pending) > 0

    # Does this user have projects from before workspaces existed? Drives
    # the onboarding split: new users get signup-time team name, legacy
    # users get the "we've added teams" migration screen.
    legacy_probe = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "directus_user_id": {"_eq": auth.user_id},
                    "workspace_id": {"_null": True},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    has_legacy_projects = isinstance(legacy_probe, list) and len(legacy_probe) > 0

    if not app_user:
        return MeResponse(
            directus_user_id=auth.user_id,
            email=email,
            display_name=directus_profile.get("display_name", ""),
            avatar=directus_profile.get("avatar"),
            onboarding_completed=False,
            has_pending_invites=has_pending_invites,
            has_legacy_projects=has_legacy_projects,
            is_staff=bool(auth.is_admin),
        )

    # Fetch org memberships
    orgs: list[OrgSummary] = []
    org_memberships = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user["id"]},
                    "deleted_at": {"_null": True},
                },
                "fields": ["org_id", "role"],
                "limit": -1,
            }
        },
    )
    if isinstance(org_memberships, list) and len(org_memberships) > 0:
        org_ids = [m["org_id"] for m in org_memberships if m.get("org_id")]
        org_data = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": org_ids}, "deleted_at": {"_null": True}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        org_map = {o["id"]: o for o in (org_data or []) if isinstance(o, dict)}
        for m in org_memberships:
            org = org_map.get(m["org_id"])
            if org:
                orgs.append(OrgSummary(
                    id=org["id"],
                    name=org.get("name", ""),
                    role=m["role"],
                ))

    return MeResponse(
        id=app_user["id"],
        directus_user_id=auth.user_id,
        email=app_user.get("email") or email,
        display_name=app_user.get("display_name") or directus_profile.get("display_name", ""),
        avatar=directus_profile.get("avatar"),
        onboarding_completed=True,
        orgs=orgs,
        has_pending_invites=has_pending_invites,
        has_legacy_projects=has_legacy_projects,
        is_staff=bool(auth.is_admin),
    )


class UpdateMeRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=80)


@router.patch("")
async def update_me(
    body: UpdateMeRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Update the current user's profile (display_name only for now)."""
    app_user = await get_app_user_or_raise(auth.user_id)

    payload = {}
    if body.display_name is not None:
        # Strip control chars — display_name lands in email subject lines
        # (invite "{inviter_name} invited you...") so CR/LF must not pass.
        cleaned = body.display_name.replace("\r", " ").replace("\n", " ").strip()
        payload["display_name"] = cleaned

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("app_user", app_user["id"], payload)
    return {"status": "success"}


class MyPendingInvite(BaseModel):
    id: str
    workspace_id: str
    workspace_name: str
    org_name: str
    role: str
    invited_by_name: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


@router.get("/invites", response_model=list[MyPendingInvite])
async def get_my_invites(auth: DependencyDirectusSession) -> list[MyPendingInvite]:
    """List pending workspace invites sent to the current user's email."""
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        return []

    email = (app_user.get("email") or "").lower()
    if not email:
        profile = await get_directus_user_profile(auth.user_id)
        email = (profile.get("email") if profile else "") or ""
    if not email:
        return []

    now_iso = datetime.now(timezone.utc).isoformat()
    invites = await async_directus.get_items(
        "workspace_invite",
        {"query": {
            "filter": {
                "email": {"_eq": email.lower()},
                "accepted_at": {"_null": True},
                "expires_at": {"_gt": now_iso},
            },
            "fields": ["id", "workspace_id", "role", "invited_by", "created_at", "expires_at"],
            "sort": ["-created_at"],
            "limit": -1,
        }},
    )

    if not isinstance(invites, list) or not invites:
        return []

    # Batch fetch workspaces + inviters
    ws_ids = list({inv["workspace_id"] for inv in invites if inv.get("workspace_id")})
    inviter_ids = list({inv["invited_by"] for inv in invites if inv.get("invited_by")})

    ws_map: dict[str, dict] = {}
    org_map: dict[str, str] = {}
    if ws_ids:
        workspaces = await async_directus.get_items(
            "workspace",
            {"query": {
                "filter": {"id": {"_in": ws_ids}, "deleted_at": {"_null": True}},
                "fields": ["id", "name", "org_id"],
                "limit": -1,
            }},
        )
        if isinstance(workspaces, list):
            ws_map = {w["id"]: w for w in workspaces}
            org_ids = list({w.get("org_id") for w in workspaces if w.get("org_id")})
            if org_ids:
                orgs_data = await async_directus.get_items(
                    "org",
                    {"query": {"filter": {"id": {"_in": org_ids}}, "fields": ["id", "name"], "limit": -1}},
                )
                if isinstance(orgs_data, list):
                    org_map = {o["id"]: o.get("name", "") for o in orgs_data}

    inviter_map: dict[str, str] = {}
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
            inviter_map = {u["id"]: u.get("display_name") or "" for u in inviters}

    results: list[MyPendingInvite] = []
    for inv in invites:
        ws = ws_map.get(inv.get("workspace_id", ""))
        if not ws:
            continue
        results.append(MyPendingInvite(
            id=inv["id"],
            workspace_id=inv["workspace_id"],
            workspace_name=ws.get("name", ""),
            org_name=org_map.get(ws.get("org_id", ""), ""),
            role=inv.get("role", ""),
            invited_by_name=inviter_map.get(inv.get("invited_by", "")) or None,
            created_at=inv.get("created_at"),
            expires_at=inv.get("expires_at"),
        ))

    return results


@router.post("/invites/{invite_id}/accept")
async def accept_my_invite(invite_id: str, auth: DependencyDirectusSession) -> dict:
    """Accept a pending workspace invite by ID (used by /invites page)."""
    from dembrane.utils import generate_uuid
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    await _accept_rate_limiter.check(app_user_id)
    email = (app_user.get("email") or "").lower()

    invite = await async_directus.get_item("workspace_invite", invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    if (invite.get("email") or "").lower() != email:
        raise HTTPException(status_code=403, detail="This invite isn't for you")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite already accepted")

    now_iso = datetime.now(timezone.utc).isoformat()
    if invite.get("expires_at") and invite["expires_at"] < now_iso:
        raise HTTPException(status_code=400, detail="Invite has expired")

    # Check if workspace still exists
    ws = await async_directus.get_item("workspace", invite["workspace_id"])
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace no longer exists")

    # Add org membership if requested. Track whether we freshly created
    # the row so the TEAM_MEMBER_ADDED notification only fires once per
    # new team joiner (not every time an existing team member accepts
    # a workspace invite).
    newly_joined_team = False
    if invite.get("include_org_membership") and ws.get("org_id"):
        existing_org_mem = await async_directus.get_items(
            "org_membership",
            {"query": {"filter": {
                "org_id": {"_eq": ws["org_id"]},
                "user_id": {"_eq": app_user_id},
                "deleted_at": {"_null": True},
            }, "limit": 1}},
        )
        if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
            await async_directus.create_item("org_membership", {
                "id": generate_uuid(),
                "org_id": ws["org_id"],
                "user_id": app_user_id,
                "role": "member",
            })
            newly_joined_team = True

    # Create workspace membership (if not already)
    existing_ws_mem = await async_directus.get_items(
        "workspace_membership",
        {"query": {"filter": {
            "workspace_id": {"_eq": invite["workspace_id"]},
            "user_id": {"_eq": app_user_id},
            "deleted_at": {"_null": True},
        }, "limit": 1}},
    )
    if not (isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0):
        await async_directus.create_item("workspace_membership", {
            "id": generate_uuid(),
            "workspace_id": invite["workspace_id"],
            "user_id": app_user_id,
            "role": invite.get("role", "member"),
            "source": "direct",
            "is_external": not invite.get("include_org_membership", False),
        })

    # Mark invite as accepted
    await async_directus.update_item("workspace_invite", invite_id, {
        "accepted_at": now_iso,
    })

    # Notify the inviter that their invite was accepted.
    inviter_id = invite.get("invited_by")
    if inviter_id and inviter_id != app_user_id:
        from dembrane.notifications import emit
        accepter_name = app_user.get("display_name") or app_user.get("email") or "Someone"
        await emit(
            audience_user_id=inviter_id,
            actor_user_id=app_user_id,
            event_code="INVITE_ACCEPTED",
            title=f"{accepter_name} joined {ws.get('name', 'your workspace')}",
            message="They accepted your invite and can now collaborate.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=invite["workspace_id"],
            ref_org_id=ws.get("org_id"),
        )

    # TEAM_MEMBER_ADDED — fires once, when the invitee is new to the
    # team. Announces the new teammate to team admins.
    if newly_joined_team and ws.get("org_id"):
        from dembrane.notifications import (
            audience_team_admins,
            emit_to_audience,
        )
        team_admin_ids = await audience_team_admins(ws["org_id"])
        team_row = await async_directus.get_item("org", ws["org_id"])
        team_name = (team_row or {}).get("name") or "the team"
        new_member_name = (
            app_user.get("display_name") or app_user.get("email") or "A new member"
        )
        await emit_to_audience(
            team_admin_ids,
            actor_user_id=inviter_id,
            event_code="TEAM_MEMBER_ADDED",
            title=f"{new_member_name} joined {team_name}",
            message="They're now a team member.",
            action="NAVIGATE_TEAM_SETTINGS",
            ref_org_id=ws["org_id"],
        )

    return {"status": "success", "workspace_id": invite["workspace_id"]}


@router.post("/invites/{invite_id}/decline")
async def decline_my_invite(invite_id: str, auth: DependencyDirectusSession) -> dict:
    """Decline a pending workspace invite (deletes the row)."""
    app_user = await get_app_user_or_raise(auth.user_id)
    email = (app_user.get("email") or "").lower()

    invite = await async_directus.get_item("workspace_invite", invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    if (invite.get("email") or "").lower() != email:
        raise HTTPException(status_code=403, detail="This invite isn't for you")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite already accepted")

    # Notify the inviter before deletion (we still have the row).
    inviter_id = invite.get("invited_by")
    if inviter_id:
        ws_for_notif = await async_directus.get_item("workspace", invite.get("workspace_id"))
        ws_name = (ws_for_notif or {}).get("name") or "a workspace"
        from dembrane.notifications import emit
        await emit(
            audience_user_id=inviter_id,
            actor_user_id=app_user["id"],
            event_code="INVITE_DECLINED",
            title=f"{email} declined your invite",
            message=f"They chose not to join **{ws_name}**.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=invite.get("workspace_id"),
        )

    await async_directus.delete_item("workspace_invite", invite_id)
    return {"status": "success"}




class AcceptByHashRequest(BaseModel):
    hash: str
    claimed_role: Optional[str] = None  # honeypot — URL-claimed role


@router.post("/invites/accept-by-hash")
async def accept_invite_by_hash(
    body: AcceptByHashRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Accept a pending invite whose HMAC hash matches.

    Flow:
      1. Fetch all pending invites for the logged-in user's email.
      2. For each, compute HMAC hash and compare (constant-time) to body.hash.
      3. Accept the matching one.

    Security layers:
      - Email ownership (Directus verification + login)
      - HMAC of invite_id (unforgeable without server secret)
      - Honeypot: if URL-claimed role > actual role, return 418
    """
    from dembrane.utils import generate_uuid
    import hmac as _hmac
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    await _accept_rate_limiter.check(app_user_id)
    my_email = (app_user.get("email") or "").lower()
    if not my_email:
        raise HTTPException(status_code=400, detail="User has no email")

    now_iso = datetime.now(timezone.utc).isoformat()

    # First check pending invites for this email
    invites = await async_directus.get_items(
        "workspace_invite",
        {"query": {
            "filter": {
                "email": {"_eq": my_email},
                "accepted_at": {"_null": True},
                "expires_at": {"_gt": now_iso},
            },
            "fields": ["id", "email", "workspace_id", "role", "include_org_membership"],
            "limit": -1,
        }},
    )

    # Constant-time comparison to prevent timing attacks
    target_invite = None
    if isinstance(invites, list):
        for inv in invites:
            if _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                target_invite = inv
                break

    # Fallback: invite may have already been marked accepted (e.g. via
    # onboarding auto-accept) but the workspace_membership row might be
    # missing — a prior accept that created the accepted_at row but
    # failed to create the membership (partial-write, race, or a Directus
    # error retried by the client) used to dead-end here with "Invite
    # not found or already handled". Now we self-heal: the email match +
    # unforgeable hash is strong enough proof of ownership to create the
    # missing membership and let the user in.
    if target_invite is None:
        accepted = await async_directus.get_items(
            "workspace_invite",
            {"query": {
                "filter": {"email": {"_eq": my_email}},
                "fields": [
                    "id",
                    "workspace_id",
                    "accepted_at",
                    "role",
                    "include_org_membership",
                ],
                "limit": -1,
            }},
        )
        if isinstance(accepted, list):
            for inv in accepted:
                if not _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                    continue
                ws = await async_directus.get_item("workspace", inv["workspace_id"])
                if not ws or ws.get("deleted_at"):
                    raise HTTPException(
                        status_code=404, detail="Workspace no longer exists"
                    )

                existing = await async_directus.get_items(
                    "workspace_membership",
                    {"query": {"filter": {
                        "workspace_id": {"_eq": inv["workspace_id"]},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    }, "fields": ["id"], "limit": 1}},
                )
                already_member = (
                    isinstance(existing, list) and len(existing) > 0
                )
                if already_member:
                    return {
                        "status": "already_member",
                        "workspace_id": inv["workspace_id"],
                        "workspace_name": ws.get("name", ""),
                    }

                # Heal the missing membership. Role + external flag come
                # from the invite row itself — we don't trust any
                # client-provided role here.
                invite_role = inv.get("role", "member")
                include_org = bool(inv.get("include_org_membership"))
                logger.warning(
                    "accept-by-hash fallback healed missing workspace_membership "
                    f"for user={app_user_id} invite={inv['id']} ws={inv['workspace_id']}"
                )

                if include_org and ws.get("org_id"):
                    existing_org_mem = await async_directus.get_items(
                        "org_membership",
                        {"query": {"filter": {
                            "org_id": {"_eq": ws["org_id"]},
                            "user_id": {"_eq": app_user_id},
                            "deleted_at": {"_null": True},
                        }, "limit": 1}},
                    )
                    if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
                        await async_directus.create_item("org_membership", {
                            "id": generate_uuid(),
                            "org_id": ws["org_id"],
                            "user_id": app_user_id,
                            "role": "member",
                        })

                await async_directus.create_item("workspace_membership", {
                    "id": generate_uuid(),
                    "workspace_id": inv["workspace_id"],
                    "user_id": app_user_id,
                    "role": invite_role,
                    "source": "direct",
                    "is_external": not include_org,
                })

                # accepted_at is already set (that's why we're in the
                # fallback); no need to touch it again.
                return {
                    "status": "success",
                    "workspace_id": inv["workspace_id"],
                    "workspace_name": ws.get("name", ""),
                }

        raise HTTPException(status_code=404, detail="Invite not found or already handled")

    actual_role = target_invite.get("role", "member")

    # Honeypot
    if body.claimed_role:
        claimed = _ROLE_LEVEL.get(body.claimed_role, -1)
        actual = _ROLE_LEVEL.get(actual_role, 0)
        if claimed > actual:
            logger.warning(
                f"HONEYPOT: {my_email} tried accept with claimed_role={body.claimed_role} "
                f"but actual role is {actual_role}"
            )
            raise HTTPException(
                status_code=418,
                detail=(
                    "Nice try. We noticed the URL tampering. "
                    "If you enjoy finding edge cases, come work with us: "
                    "sameer@dembrane.com"
                ),
            )

    ws = await async_directus.get_item("workspace", target_invite["workspace_id"])
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace no longer exists")

    # Add to org if requested
    if target_invite.get("include_org_membership") and ws.get("org_id"):
        existing_org_mem = await async_directus.get_items(
            "org_membership",
            {"query": {"filter": {
                "org_id": {"_eq": ws["org_id"]},
                "user_id": {"_eq": app_user_id},
                "deleted_at": {"_null": True},
            }, "limit": 1}},
        )
        if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
            await async_directus.create_item("org_membership", {
                "id": generate_uuid(),
                "org_id": ws["org_id"],
                "user_id": app_user_id,
                "role": "member",
            })

    # Create workspace membership
    existing_ws_mem = await async_directus.get_items(
        "workspace_membership",
        {"query": {"filter": {
            "workspace_id": {"_eq": target_invite["workspace_id"]},
            "user_id": {"_eq": app_user_id},
            "deleted_at": {"_null": True},
        }, "limit": 1}},
    )
    if not (isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0):
        await async_directus.create_item("workspace_membership", {
            "id": generate_uuid(),
            "workspace_id": target_invite["workspace_id"],
            "user_id": app_user_id,
            "role": actual_role,
            "source": "direct",
            "is_external": not target_invite.get("include_org_membership", False),
        })

    await async_directus.update_item("workspace_invite", target_invite["id"], {
        "accepted_at": now_iso,
    })

    # INVITE_ACCEPTED → the person who sent the invite. Mirrors the
    # notification in accept_my_invite; same event regardless of
    # whether the invitee came via the inbox page or the email link.
    inviter_id = target_invite.get("invited_by")
    if inviter_id and inviter_id != app_user_id:
        from dembrane.notifications import emit
        accepter_name = app_user.get("display_name") or my_email or "Someone"
        await emit(
            audience_user_id=inviter_id,
            actor_user_id=app_user_id,
            event_code="INVITE_ACCEPTED",
            title=f"{accepter_name} joined {ws.get('name', 'your workspace')}",
            message="They accepted your invite and can now collaborate.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=target_invite["workspace_id"],
            ref_org_id=ws.get("org_id"),
        )

    # TEAM_MEMBER_ADDED → team admins, but only when the invite granted
    # org membership AND the invitee wasn't already on the team (i.e.
    # we just created the org_membership row a few lines above).
    if (
        target_invite.get("include_org_membership")
        and ws.get("org_id")
        and not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0)
    ):
        from dembrane.notifications import (
            audience_team_admins,
            emit_to_audience,
        )
        team_admin_ids = await audience_team_admins(ws["org_id"])
        team_row = await async_directus.get_item("org", ws["org_id"])
        team_name = (team_row or {}).get("name") or "the team"
        new_member_name = app_user.get("display_name") or my_email or "A new member"
        await emit_to_audience(
            team_admin_ids,
            actor_user_id=inviter_id,
            event_code="TEAM_MEMBER_ADDED",
            title=f"{new_member_name} joined {team_name}",
            message="They're now a team member.",
            action="NAVIGATE_TEAM_SETTINGS",
            ref_org_id=ws["org_id"],
        )

    return {
        "status": "success",
        "workspace_id": target_invite["workspace_id"],
        "workspace_name": ws.get("name", ""),
    }
