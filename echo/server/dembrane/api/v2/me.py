"""GET /v2/me — lightweight user profile with onboarding status."""

from logging import getLogger
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from dembrane.app_user import resolve_app_user, get_directus_user_profile, get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import MeResponse, OrgSummary
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.me")


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

    if not app_user:
        return MeResponse(
            directus_user_id=auth.user_id,
            email=email,
            display_name=directus_profile.get("display_name", ""),
            avatar=directus_profile.get("avatar"),
            onboarding_completed=False,
            has_pending_invites=has_pending_invites,
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
        payload["display_name"] = body.display_name.strip()

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
    """Accept a pending workspace invite by ID."""
    from dembrane.utils import generate_uuid
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
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

    # Add org membership if requested
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

    await async_directus.delete_item("workspace_invite", invite_id)
    return {"status": "success"}


class AcceptByTokenRequest(BaseModel):
    claimed_role: Optional[str] = None  # what the email URL said the role was (honeypot)


_ROLE_LEVEL = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


@router.post("/invites/by-token/{token}/accept")
async def accept_invite_by_token(
    token: str,
    auth: DependencyDirectusSession,
    body: Optional[AcceptByTokenRequest] = None,
) -> dict:
    """Accept a pending invite by token (for email link flow).

    Requires auth — if the user isn't logged in, the frontend should route them
    through login/register first, preserving the token in the URL.
    """
    from dembrane.utils import generate_uuid
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    my_email = (app_user.get("email") or "").lower()

    now_iso = datetime.now(timezone.utc).isoformat()
    invites = await async_directus.get_items(
        "workspace_invite",
        {"query": {
            "filter": {
                "token": {"_eq": token},
                "accepted_at": {"_null": True},
                "expires_at": {"_gt": now_iso},
            },
            "fields": ["id", "email", "workspace_id", "role", "include_org_membership"],
            "limit": 1,
        }},
    )
    if not isinstance(invites, list) or not invites:
        raise HTTPException(status_code=404, detail="Invite not found or expired")

    invite = invites[0]
    invite_email = (invite.get("email") or "").lower()
    actual_role = invite.get("role", "member")

    # Honeypot: if the URL-claimed role is higher than the actual role, they
    # tried to escalate via URL tampering. Log it and send them a fun 418.
    if body and body.claimed_role:
        claimed_level = _ROLE_LEVEL.get(body.claimed_role, -1)
        actual_level = _ROLE_LEVEL.get(actual_role, 0)
        if claimed_level > actual_level:
            logger.warning(
                f"HONEYPOT: user {my_email} tried to accept invite with claimed_role="
                f"{body.claimed_role} but actual role is {actual_role}"
            )
            raise HTTPException(
                status_code=418,
                detail=(
                    "Nice try — we noticed the URL tampering. "
                    "If you enjoy finding edge cases, come work with us: "
                    "sameer@dembrane.com"
                ),
            )

    # Verify the invite is for this user's email
    if invite_email != my_email:
        raise HTTPException(
            status_code=403,
            detail=f"This invite is for {invite_email}. You're logged in as {my_email}.",
        )

    ws = await async_directus.get_item("workspace", invite["workspace_id"])
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace no longer exists")

    # Add to org if requested
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

    # Create workspace membership
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

    await async_directus.update_item("workspace_invite", invite["id"], {
        "accepted_at": now_iso,
    })

    return {
        "status": "success",
        "workspace_id": invite["workspace_id"],
        "workspace_name": ws.get("name", ""),
    }
