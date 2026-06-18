"""GET /v2/me — lightweight user profile with onboarding status."""

from typing import Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.app_user import resolve_app_user, get_app_user_or_raise, get_directus_user_profile
from dembrane.policies import ROLE_HIERARCHY as _ROLE_LEVEL
from dembrane.seat_capacity import assert_can_add_seat
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.invites import compute_invite_hash
from dembrane.api.v2.schemas import MeResponse, OrgSummary
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.api.v2._invite_helpers import (
    create_membership_row,
    reactivate_membership_row,
)

router = APIRouter()
logger = getLogger("api.v2.me")

_accept_rate_limiter = create_user_rate_limiter(
    # 60 attempts/hour. Was 30, raised after a tester locked themselves
    # out clicking "Try again" while waiting for an admin to free a seat
    # — each cap-blocked retry burned a slot. accept_my_invite now runs
    # the rate limiter AFTER the cap check so 402s don't count, but the
    # accept-by-hash path still increments on the brute-force gate, so
    # 60 keeps that path generous for legit retries.
    name="invite_accept",
    capacity=60,
    window_seconds=3600,
)


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

    # Org-only invites must count here so onboarding doesn't show "name your organisation" to an invited user.
    has_pending_invites = False
    if email:
        now_iso = datetime.now(timezone.utc).isoformat()
        pending_ws = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
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
        if isinstance(pending_ws, list) and len(pending_ws) > 0:
            has_pending_invites = True
        else:
            pending_org = await async_directus.get_items(
                "org_invite",
                {
                    "query": {
                        "filter": {
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
            has_pending_invites = isinstance(pending_org, list) and len(pending_org) > 0

    # Does this user have projects from before workspaces existed? Drives
    # the onboarding split: new users get signup-time organisation name, legacy
    # users get the "we've added organisations" migration screen.
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
                    "fields": ["id", "name", "is_partner"],
                    "limit": -1,
                }
            },
        )
        org_map = {o["id"]: o for o in (org_data or []) if isinstance(o, dict)}
        for m in org_memberships:
            org = org_map.get(m["org_id"])
            if org:
                orgs.append(
                    OrgSummary(
                        id=org["id"],
                        name=org.get("name", ""),
                        role=m["role"],
                        is_partner=bool(org.get("is_partner")),
                    )
                )

    onboarding_answers = app_user.get("onboarding_answer_json")
    if not isinstance(onboarding_answers, dict):
        onboarding_answers = None

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
        onboarding_answer_json=onboarding_answers,
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
    """Single pending invite for the current user. ADR 0004: org-only
    invites have no workspace context — `type` discriminates, and
    workspace_* fields are absent on org-only rows."""

    id: str
    # "workspace" | "org"
    type: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    # Always present in practice; empty-string fallback so consumers don't have to branch on the orphan-workspace edge case.
    org_id: str = ""
    org_name: str = ""
    role: str
    invited_by_name: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


@router.get("/invites", response_model=list[MyPendingInvite])
async def get_my_invites(auth: DependencyDirectusSession) -> list[MyPendingInvite]:
    """List pending invites sent to the current user's email.

    Returns workspace_invite AND org_invite rows (ADR 0004). Org-only
    invitees would otherwise see "0 invites" on /me/invites, /w, and
    the onboarding welcome list.
    """
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

    # deleted_at filter required so revoked invites don't appear in the listing.
    ws_invites_raw = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "email": {"_eq": email.lower()},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id", "workspace_id", "role", "invited_by", "created_at", "expires_at"],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    ws_invites = ws_invites_raw if isinstance(ws_invites_raw, list) else []

    org_invites_raw = await async_directus.get_items(
        "org_invite",
        {
            "query": {
                "filter": {
                    "email": {"_eq": email.lower()},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id", "org_id", "role", "invited_by", "created_at", "expires_at"],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    org_invites = org_invites_raw if isinstance(org_invites_raw, list) else []

    if not ws_invites and not org_invites:
        return []

    # Batch fetch workspaces, orgs (both kinds), and inviters.
    ws_ids = list({inv["workspace_id"] for inv in ws_invites if inv.get("workspace_id")})
    inviter_ids = list(
        {inv["invited_by"] for inv in (ws_invites + org_invites) if inv.get("invited_by")}
    )

    ws_map: dict[str, dict] = {}
    org_map: dict[str, str] = {}
    org_ids_from_ws: list[str] = []
    if ws_ids:
        workspaces = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {"id": {"_in": ws_ids}, "deleted_at": {"_null": True}},
                    "fields": ["id", "name", "org_id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(workspaces, list):
            ws_map = {w["id"]: w for w in workspaces}
            org_ids_from_ws = list({w.get("org_id") for w in workspaces if w.get("org_id")})

    org_ids_from_invites = list({inv["org_id"] for inv in org_invites if inv.get("org_id")})
    all_org_ids = list(set(org_ids_from_ws) | set(org_ids_from_invites))
    if all_org_ids:
        orgs_data = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": all_org_ids}, "deleted_at": {"_null": True}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(orgs_data, list):
            org_map = {o["id"]: o.get("name", "") for o in orgs_data}

    inviter_map: dict[str, str] = {}
    if inviter_ids:
        inviters = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": inviter_ids}},
                    "fields": ["id", "display_name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(inviters, list):
            inviter_map = {u["id"]: u.get("display_name") or "" for u in inviters}

    results: list[MyPendingInvite] = []
    for inv in ws_invites:
        ws = ws_map.get(inv.get("workspace_id", ""))
        if not ws:
            continue  # workspace deleted; drop the invite
        results.append(
            MyPendingInvite(
                id=inv["id"],
                type="workspace",
                workspace_id=inv["workspace_id"],
                workspace_name=ws.get("name", ""),
                org_id=ws.get("org_id") or "",
                org_name=org_map.get(ws.get("org_id", ""), ""),
                role=inv.get("role", ""),
                invited_by_name=inviter_map.get(inv.get("invited_by", "")) or None,
                created_at=inv.get("created_at"),
                expires_at=inv.get("expires_at"),
            )
        )
    for inv in org_invites:
        org_id = inv.get("org_id")
        org_name = org_map.get(org_id, "") if org_id else ""
        if org_id and not org_name and org_id not in org_map:
            continue  # org deleted; skip silently
        results.append(
            MyPendingInvite(
                id=inv["id"],
                type="org",
                org_id=org_id,
                org_name=org_name,
                role=inv.get("role", ""),
                invited_by_name=inviter_map.get(inv.get("invited_by", "")) or None,
                created_at=inv.get("created_at"),
                expires_at=inv.get("expires_at"),
            )
        )

    results.sort(key=lambda r: r.created_at or "", reverse=True)
    return results


@router.post("/invites/{invite_id}/accept")
async def accept_my_invite(invite_id: str, auth: DependencyDirectusSession) -> dict:
    """Accept a pending invite by ID. Dispatches to workspace_invite or
    org_invite based on which table holds the id (ADR 0004).

    Filter-based lookup on both tables avoids Directus's get_item
    FORBIDDEN-on-missing probe trap when the id doesn't belong to a
    given collection.
    """
    from dembrane.utils import generate_uuid

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    email = (app_user.get("email") or "").lower()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Probe workspace_invite first; revoked rows filtered at query level so a hardcoded URL can't reach acceptance.
    ws_rows = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "id": {"_eq": invite_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    invite = ws_rows[0] if isinstance(ws_rows, list) and ws_rows else None

    if invite is None:
        org_rows = await async_directus.get_items(
            "org_invite",
            {
                "query": {
                    "filter": {
                        "id": {"_eq": invite_id},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        org_invite = org_rows[0] if isinstance(org_rows, list) and org_rows else None
        if org_invite is None:
            raise HTTPException(status_code=404, detail="Invite not found")

        return await _accept_org_invite_by_id(
            org_invite=org_invite,
            app_user_id=app_user_id,
            email=email,
            now_iso=now_iso,
        )

    if (invite.get("email") or "").lower() != email:
        raise HTTPException(status_code=403, detail="This invite isn't for you")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite already accepted")
    if invite.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Invite not found")  # revoked; surface as not-found

    # Hoist inviter_id once so every notification block below can reference
    # it without depending on the assignment landing inside a conditional
    # earlier in the function. Cheap insurance against a future refactor
    # that would otherwise NameError on the WORKSPACE_GUEST_ADDED branch.
    inviter_id = invite.get("invited_by")

    if invite.get("expires_at") and invite["expires_at"] < now_iso:
        raise HTTPException(status_code=400, detail="Invite has expired")

    # Check if workspace still exists
    ws = await async_directus.get_item("workspace", invite["workspace_id"])
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace no longer exists")

    invite_role = invite.get("role") or "member"
    is_external_invite = invite_role == "external"

    # Race-protection: cap may have shrunk between invite-send and accept.
    # Unified seat pool — members and externals share capacity (ADR-0003).
    await assert_can_add_seat(ws, audience="invitee")

    # Rate-limit AFTER the cap check so a user retrying while waiting for
    # an admin to free a seat doesn't burn through their quota on attempts
    # that never had a chance to succeed.
    await _accept_rate_limiter.check(app_user_id)

    # Invariant (ADR-0003): role='external' ⟺ no org_membership row in
    # this org. Non-external invites ensure an org_membership row exists.
    newly_joined_organisation = False
    if not is_external_invite and ws.get("org_id"):
        existing_org_mem = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": ws["org_id"]},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
            newly_joined_organisation = await create_membership_row(
                async_directus,
                "org_membership",
                {
                    "id": generate_uuid(),
                    "org_id": ws["org_id"],
                    "user_id": app_user_id,
                    "role": "member",
                },
            )

    # External acceptance: enforce insider XOR outsider before creating the
    # external row.
    if is_external_invite and ws.get("org_id"):
        from dembrane.api.v2._invite_helpers import (
            reconcile_external_membership_org_row,
        )

        await reconcile_external_membership_org_row(ws["org_id"], app_user_id)

    # Create workspace membership (if not already)
    existing_ws_mem = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": invite["workspace_id"]},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    if not (isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0):
        if await create_membership_row(
            async_directus,
            "workspace_membership",
            {
                "id": generate_uuid(),
                "workspace_id": invite["workspace_id"],
                "user_id": app_user_id,
                "role": invite_role,
                "source": "direct",
            },
        ):
            from dembrane.cache_utils import invalidate_workspace_and_org_usage

            await invalidate_workspace_and_org_usage(invite["workspace_id"], ws.get("org_id"))

    # Mark invite as accepted
    await async_directus.update_item(
        "workspace_invite",
        invite_id,
        {
            "accepted_at": now_iso,
        },
    )

    # Seat consumed now: reconcile billing so the prorated charge lands at the
    # accept moment and the next renewal reflects the new seat. Best-effort: a
    # billing hiccup must never fail the accept. Idempotent (provisioned_seats),
    # so the periodic cron stays a safe backstop.
    try:
        from dembrane.billing_service import (
            reconcile_account_seats,
            get_account_for_workspace,
        )

        billing_account = await get_account_for_workspace(invite["workspace_id"])
        if billing_account:
            await reconcile_account_seats(billing_account["id"])
    except Exception:
        logger.exception(
            "Seat reconcile failed after %s accepted invite to workspace %s",
            app_user_id,
            invite["workspace_id"],
        )

    # Notify the inviter that their invite was accepted. inviter_id is
    # already hoisted at the top of the function (defensive — see comment
    # there) so we just gate the emit, not the assignment.
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

    # ORGANISATION_MEMBER_ADDED — fires once, when the invitee is new to the
    # organisation. Announces the new member to organisation admins.
    if newly_joined_organisation and ws.get("org_id"):
        from dembrane.notifications import (
            emit_to_audience,
            audience_organisation_admins,
        )

        organisation_admin_ids = await audience_organisation_admins(ws["org_id"])
        organisation_row = await async_directus.get_item("org", ws["org_id"])
        organisation_name = (organisation_row or {}).get("name") or "the organisation"
        new_member_name = app_user.get("display_name") or app_user.get("email") or "A new member"
        await emit_to_audience(
            organisation_admin_ids,
            actor_user_id=inviter_id,
            event_code="ORGANISATION_MEMBER_ADDED",
            title=f"{new_member_name} joined {organisation_name}",
            message="They're now a organisation member.",
            action="NAVIGATE_ORGANISATION_SETTINGS",
            ref_org_id=ws["org_id"],
        )

    # WORKSPACE_GUEST_ADDED → workspace admins when a guest accepts.
    # Guests don't fire ORGANISATION_MEMBER_ADDED, so without this admins
    # never hear about them joining. Excludes the inviter (already
    # notified by INVITE_ACCEPTED) and the invitee.
    if is_external_invite:
        from dembrane.notifications import (
            emit_to_audience,
            audience_workspace_admins,
        )

        admin_ids = await audience_workspace_admins(invite["workspace_id"])
        admin_ids = [a for a in admin_ids if a != app_user_id and a != inviter_id]
        external_name = app_user.get("display_name") or app_user.get("email") or "An external"
        ws_name = ws.get("name") or "your workspace"
        await emit_to_audience(
            admin_ids,
            actor_user_id=app_user_id,
            event_code="WORKSPACE_GUEST_ADDED",
            title=f"{external_name} joined {ws_name} as an external",
            message=(
                f"{app_user.get('email') or 'An external'} now has external access. "
                "Externals count against your tier's seat cap."
            ),
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=invite["workspace_id"],
            ref_org_id=ws.get("org_id"),
        )

    # Multi-pending consume: apply every other pending invite for (email, org_id) so the user gets all promised memberships in one accept.
    if ws.get("org_id") and not is_external_invite:
        await _consume_pending_invites_in_org(
            email=email,
            org_id=ws["org_id"],
            app_user_id=app_user_id,
            exclude_workspace_invite_id=invite_id,
        )

    return {
        "status": "success",
        "type": "workspace",
        "workspace_id": invite["workspace_id"],
        "workspace_name": ws.get("name", ""),
        "org_id": ws.get("org_id"),
    }


async def _accept_org_invite_by_id(
    *,
    org_invite: dict,
    app_user_id: str,
    email: str,
    now_iso: str,
) -> dict:
    """Accept an org_invite by id (used by /invites page). Mirrors the
    org branch of accept-by-hash without the HMAC layer — the id itself
    is the proof, plus email-match for ownership."""
    from dembrane.utils import generate_uuid

    if (org_invite.get("email") or "").lower() != email:
        raise HTTPException(status_code=403, detail="This invite isn't for you")
    if org_invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite already accepted")
    if org_invite.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Invite not found")
    if org_invite.get("expires_at") and org_invite["expires_at"] < now_iso:
        raise HTTPException(status_code=400, detail="Invite has expired")

    invite_org_id = org_invite["org_id"]
    invite_role = org_invite.get("role") or "member"

    org_row = await async_directus.get_item("org", invite_org_id)
    if not org_row or org_row.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Organisation no longer exists")

    await _accept_rate_limiter.check(app_user_id)

    # Fetch active + soft-deleted org_membership rows; pick deterministically (no unique constraint on (org_id, user_id)).
    existing_org_mem = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": invite_org_id},
                    "user_id": {"_eq": app_user_id},
                },
                "fields": ["id", "role", "deleted_at"],
                "limit": -1,
            }
        },
    )

    active_row = None
    deleted_row = None
    if isinstance(existing_org_mem, list):
        for row in existing_org_mem:
            if row.get("deleted_at") is None and active_row is None:
                active_row = row
            elif row.get("deleted_at") is not None and deleted_row is None:
                deleted_row = row

    already_active_member = False
    if active_row is not None:
        already_active_member = True
    elif deleted_row is not None:
        if not await reactivate_membership_row(
            async_directus,
            "org_membership",
            deleted_row["id"],
            {"deleted_at": None, "role": invite_role},
        ):
            already_active_member = True
    else:
        if not await create_membership_row(
            async_directus,
            "org_membership",
            {
                "id": generate_uuid(),
                "org_id": invite_org_id,
                "user_id": app_user_id,
                "role": invite_role,
            },
        ):
            already_active_member = True

    await async_directus.update_item(
        "org_invite",
        org_invite["id"],
        {"accepted_at": now_iso},
    )

    await _consume_pending_invites_in_org(
        email=email,
        org_id=invite_org_id,
        app_user_id=app_user_id,
        exclude_org_invite_id=org_invite["id"],
    )

    return {
        "status": "already_member" if already_active_member else "success",
        "type": "org",
        "org_id": invite_org_id,
        "org_name": org_row.get("name") or "",
    }


@router.post("/invites/{invite_id}/decline")
async def decline_my_invite(invite_id: str, auth: DependencyDirectusSession) -> dict:
    """Decline a pending invite (deletes the row). Handles both
    workspace_invite and org_invite ids (ADR 0004)."""
    app_user = await get_app_user_or_raise(auth.user_id)
    email = (app_user.get("email") or "").lower()

    ws_rows = await async_directus.get_items(
        "workspace_invite",
        {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
    )
    invite = ws_rows[0] if isinstance(ws_rows, list) and ws_rows else None
    is_org_invite = False

    if invite is None:
        org_rows = await async_directus.get_items(
            "org_invite",
            {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
        )
        invite = org_rows[0] if isinstance(org_rows, list) and org_rows else None
        is_org_invite = invite is not None

    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    if (invite.get("email") or "").lower() != email:
        raise HTTPException(status_code=403, detail="This invite isn't for you")
    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite already accepted")
    if invite.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Invite not found")  # revoked; don't leak existence

    # Notify the inviter before deletion (we still have the row).
    inviter_id = invite.get("invited_by")
    if inviter_id and not is_org_invite:
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
    elif inviter_id and is_org_invite:
        org_for_notif = await async_directus.get_item("org", invite.get("org_id"))
        org_name = (org_for_notif or {}).get("name") or "an organisation"
        from dembrane.notifications import emit

        await emit(
            audience_user_id=inviter_id,
            actor_user_id=app_user["id"],
            event_code="INVITE_DECLINED",
            title=f"{email} declined your invite",
            message=f"They chose not to join **{org_name}**.",
            action="NAVIGATE_ORGANISATION_SETTINGS",
            ref_org_id=invite.get("org_id"),
        )

    # Soft-delete, mirroring revoke (invite_actions.py) — keeps the audit trail.
    await async_directus.update_item(
        "org_invite" if is_org_invite else "workspace_invite",
        invite_id,
        {"deleted_at": datetime.now(timezone.utc).isoformat()},
    )
    return {"status": "success"}


class InviteByHashState(BaseModel):
    """Status enum: not_found / expired / workspace_deleted / org_deleted /
    accepted / pending. On `accepted`, read `is_member` to tell live vs
    orphaned membership.

    `type` discriminates org-only invites (ADR 0004) from workspace invites.
    org-only invites populate `org_id`/`org_name` instead of workspace_*.
    `org_deleted` only fires for `type=org`; `workspace_deleted` only for
    `type=workspace`.
    """

    status: str
    type: Optional[str] = None  # "workspace" | "org" | None
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    role: Optional[str] = None
    is_member: Optional[bool] = None
    expires_at: Optional[str] = None


@router.get("/invites/by-hash", response_model=InviteByHashState)
async def inspect_invite_by_hash(
    h: str,
    auth: DependencyDirectusSession,
) -> InviteByHashState:
    """Read-only inspect for /invite/accept page load — surfaces
    already-used links as `accepted` instead of letting the accept
    endpoint silently re-consume them. Same security model as
    accept-by-hash: session email scopes the lookup, HMAC gates."""
    import hmac as _hmac

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    my_email = (app_user.get("email") or "").lower()
    if not my_email:
        raise HTTPException(status_code=400, detail="User has no email")

    # Filter revoked rows at the query level so a hardcoded hash can't probe a cancelled invite.
    invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "email": {"_eq": my_email},
                    "deleted_at": {"_null": True},
                },
                "fields": [
                    "id",
                    "workspace_id",
                    "role",
                    "accepted_at",
                    "deleted_at",
                    "expires_at",
                ],
                "limit": -1,
            }
        },
    )

    target = None
    if isinstance(invites, list):
        for inv in invites:
            if _hmac.compare_digest(compute_invite_hash(inv["id"]), h):
                target = inv
                break

    if target is not None and target.get("deleted_at"):
        return InviteByHashState(status="not_found")

    if target is None:
        # Fall through to org_invite when the hash didn't match a workspace_invite.
        org_invites = await async_directus.get_items(
            "org_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": my_email},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "org_id",
                        "role",
                        "accepted_at",
                        "deleted_at",
                        "expires_at",
                    ],
                    "limit": -1,
                }
            },
        )
        org_target = None
        if isinstance(org_invites, list):
            for inv in org_invites:
                if _hmac.compare_digest(compute_invite_hash(inv["id"]), h):
                    org_target = inv
                    break

        if org_target is not None:
            # Check revoked BEFORE the org lookup; get_item raises FORBIDDEN on missing ids.
            if org_target.get("deleted_at"):
                return InviteByHashState(status="not_found")

            org_row = await async_directus.get_item("org", org_target["org_id"])
            now_iso_2 = datetime.now(timezone.utc).isoformat()

            existing_org_mem = await async_directus.get_items(
                "org_membership",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": org_target["org_id"]},
                            "user_id": {"_eq": app_user_id},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["id"],
                        "limit": 1,
                    }
                },
            )
            org_is_member = (
                isinstance(existing_org_mem, list) and len(existing_org_mem) > 0
            )

            base = {
                "type": "org",
                "org_id": org_target["org_id"],
                "org_name": (org_row or {}).get("name") or "",
                "role": org_target.get("role"),
                "is_member": org_is_member,
            }

            if not org_row or org_row.get("deleted_at"):
                return InviteByHashState(status="org_deleted", **base)

            if org_target.get("accepted_at"):
                return InviteByHashState(status="accepted", **base)

            if org_target.get("expires_at") and org_target["expires_at"] < now_iso_2:
                return InviteByHashState(
                    status="expired",
                    expires_at=org_target.get("expires_at"),
                    **base,
                )

            return InviteByHashState(
                status="pending",
                expires_at=org_target.get("expires_at"),
                **base,
            )

        return InviteByHashState(status="not_found")

    ws = await async_directus.get_item("workspace", target["workspace_id"])
    if not ws or ws.get("deleted_at"):
        return InviteByHashState(
            status="workspace_deleted",
            type="workspace",
            workspace_name=(ws or {}).get("name") or "",
        )

    existing_mem = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": target["workspace_id"]},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    is_member = isinstance(existing_mem, list) and len(existing_mem) > 0

    now_iso = datetime.now(timezone.utc).isoformat()

    if target.get("accepted_at"):
        return InviteByHashState(
            status="accepted",
            type="workspace",
            workspace_id=target["workspace_id"],
            workspace_name=ws.get("name") or "",
            role=target.get("role"),
            is_member=is_member,
        )

    if target.get("expires_at") and target["expires_at"] < now_iso:
        return InviteByHashState(
            status="expired",
            type="workspace",
            workspace_id=target["workspace_id"],
            workspace_name=ws.get("name") or "",
            role=target.get("role"),
            expires_at=target.get("expires_at"),
        )

    return InviteByHashState(
        status="pending",
        type="workspace",
        workspace_id=target["workspace_id"],
        workspace_name=ws.get("name") or "",
        role=target.get("role"),
        is_member=is_member,
        expires_at=target.get("expires_at"),
    )


class AcceptByHashRequest(BaseModel):
    hash: str
    claimed_role: Optional[str] = None  # honeypot — URL-claimed role


async def _consume_pending_invites_in_org(
    *,
    email: str,
    org_id: str,
    app_user_id: str,
    exclude_workspace_invite_id: Optional[str] = None,
    exclude_org_invite_id: Optional[str] = None,
) -> None:
    """Multi-pending consume: when an invite is accepted, mark every OTHER
    pending invite for the same (email, org_id) as accepted in the same
    request and apply the union of memberships. ADR 0004.

    For each remaining workspace_invite in this org: create the
    workspace_membership (if absent) and mark accepted. We do NOT raise on
    seat-cap or other errors here — the originating invite has already
    been honoured, so a per-row failure should be logged but not roll back
    the whole accept. Stale rows can be revisited from the org admin's
    Pending Invites surface.

    For each remaining org_invite in this org: just mark accepted (the
    org_membership already exists from the originating accept).

    DEVIATION FROM PLAN §2c: the plan called for "a single transaction"
    wrapping originating accept + sweep. Directus's SDK does not expose
    transaction boundaries, so this sweep is best-effort per-item:
    failures in one workspace_invite (seat-cap, deleted workspace, race)
    are logged and the loop continues. The originating accept stays
    successful regardless. The trade-off is acceptable because (a) the
    sweep is idempotent — a future accept that finds the same row still
    pending will retry, (b) seat-cap and workspace-deleted are the only
    realistic failure modes and both are recoverable from the admin's
    Pending Invites view, and (c) the alternative is a partial rollback
    of the originating accept, which would be worse UX.
    """
    from dembrane.utils import generate_uuid

    now_iso = datetime.now(timezone.utc).isoformat()

    ws_rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    ws_ids = [w["id"] for w in ws_rows] if isinstance(ws_rows, list) else []

    if ws_ids:
        # deleted_at filter is critical: without it a revoked invite would silently get accepted by the consume sweep.
        ws_invite_filter: dict = {
            "workspace_id": {"_in": ws_ids},
            "email": {"_eq": email},
            "accepted_at": {"_null": True},
            "deleted_at": {"_null": True},
            "expires_at": {"_gt": now_iso},
        }
        if exclude_workspace_invite_id:
            ws_invite_filter["id"] = {"_neq": exclude_workspace_invite_id}

        ws_invites = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": ws_invite_filter,
                    "fields": ["id", "workspace_id", "role"],
                    "limit": -1,
                }
            },
        )
        if isinstance(ws_invites, list):
            for inv in ws_invites:
                try:
                    # Cap may have shrunk since the invite was sent; skip-over-cap leaves the invite pending.
                    ws_row = await async_directus.get_item(
                        "workspace", inv["workspace_id"]
                    )
                    if not ws_row or ws_row.get("deleted_at"):
                        logger.info(
                            "multi-consume: workspace %s gone; skipping invite %s",
                            inv.get("workspace_id"),
                            inv.get("id"),
                        )
                        continue
                    try:
                        await assert_can_add_seat(ws_row, audience="invitee")
                    except HTTPException as cap_exc:
                        if cap_exc.status_code == 402:
                            logger.info(
                                "multi-consume: workspace %s over cap; skipping invite %s",
                                inv.get("workspace_id"),
                                inv.get("id"),
                            )
                            continue
                        raise

                    # Reactivate-or-create: include soft-deleted so a previously-removed member is revived, not duplicated.
                    existing_rows = await async_directus.get_items(
                        "workspace_membership",
                        {
                            "query": {
                                "filter": {
                                    "workspace_id": {"_eq": inv["workspace_id"]},
                                    "user_id": {"_eq": app_user_id},
                                },
                                "fields": ["id", "deleted_at"],
                                "limit": -1,
                            }
                        },
                    )
                    active_row = None
                    deleted_row = None
                    if isinstance(existing_rows, list):
                        for row in existing_rows:
                            if row.get("deleted_at") is None and active_row is None:
                                active_row = row
                            elif row.get("deleted_at") is not None and deleted_row is None:
                                deleted_row = row
                    if active_row is None and deleted_row is not None:
                        await reactivate_membership_row(
                            async_directus,
                            "workspace_membership",
                            deleted_row["id"],
                            {
                                "deleted_at": None,
                                "role": inv.get("role") or "member",
                                "source": "direct",
                            },
                        )
                    elif active_row is None:
                        await create_membership_row(
                            async_directus,
                            "workspace_membership",
                            {
                                "id": generate_uuid(),
                                "workspace_id": inv["workspace_id"],
                                "user_id": app_user_id,
                                "role": inv.get("role") or "member",
                                "source": "direct",
                            },
                        )
                    await async_directus.update_item(
                        "workspace_invite",
                        inv["id"],
                        {"accepted_at": now_iso},
                    )
                except Exception:
                    logger.exception(
                        "multi-consume: failed to apply workspace_invite %s for %s",
                        inv.get("id"),
                        email,
                    )

    # Org_invite sweep: membership already exists from originating accept; just mark accepted, or promote if invite role outranks.
    org_invite_filter: dict = {
        "org_id": {"_eq": org_id},
        "email": {"_eq": email},
        "accepted_at": {"_null": True},
        "deleted_at": {"_null": True},
        "expires_at": {"_gt": now_iso},
    }
    if exclude_org_invite_id:
        org_invite_filter["id"] = {"_neq": exclude_org_invite_id}

    org_invites = await async_directus.get_items(
        "org_invite",
        {"query": {"filter": org_invite_filter, "fields": ["id", "role"], "limit": -1}},
    )
    if isinstance(org_invites, list) and org_invites:
        active_org_mem_rows = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "role"],
                    "limit": 1,
                }
            },
        )
        active_org_mem = (
            active_org_mem_rows[0]
            if isinstance(active_org_mem_rows, list) and active_org_mem_rows
            else None
        )

        for inv in org_invites:
            try:
                invite_role = inv.get("role") or "member"
                # Promote if invite's role outranks the current membership.
                if active_org_mem is not None:
                    current_level = _ROLE_LEVEL.get(
                        active_org_mem.get("role") or "member", 0
                    )
                    invite_level = _ROLE_LEVEL.get(invite_role, 0)
                    if invite_level > current_level:
                        await async_directus.update_item(
                            "org_membership",
                            active_org_mem["id"],
                            {"role": invite_role},
                        )
                        active_org_mem["role"] = invite_role
                await async_directus.update_item(
                    "org_invite",
                    inv["id"],
                    {"accepted_at": now_iso},
                )
            except Exception:
                logger.exception(
                    "multi-consume: failed to mark org_invite %s accepted for %s",
                    inv.get("id"),
                    email,
                )


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
    import hmac as _hmac

    from dembrane.utils import generate_uuid

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    my_email = (app_user.get("email") or "").lower()
    if not my_email:
        raise HTTPException(status_code=400, detail="User has no email")

    now_iso = datetime.now(timezone.utc).isoformat()

    # `deleted_at IS NULL` is critical: without it a revoked invite's hash is still acceptable.
    invites = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "email": {"_eq": my_email},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id", "email", "workspace_id", "role"],
                "limit": -1,
            }
        },
    )

    # Constant-time comparison to prevent timing attacks
    target_invite = None
    if isinstance(invites, list):
        for inv in invites:
            if _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                target_invite = inv
                break

    # Fall through to org_invite when the hash didn't match a workspace_invite.
    if target_invite is None:
        org_invites_pending = await async_directus.get_items(
            "org_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": my_email},
                        "accepted_at": {"_null": True},
                        "deleted_at": {"_null": True},
                        "expires_at": {"_gt": now_iso},
                    },
                    "fields": ["id", "org_id", "role"],
                    "limit": -1,
                }
            },
        )
        target_org_invite = None
        if isinstance(org_invites_pending, list):
            for inv in org_invites_pending:
                if _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                    target_org_invite = inv
                    break

        if target_org_invite is not None:
            actual_role = target_org_invite.get("role") or "member"
            invite_org_id = target_org_invite["org_id"]

            if body.claimed_role:  # honeypot: detect URL-claimed role escalation
                claimed = _ROLE_LEVEL.get(body.claimed_role, -1)
                actual = _ROLE_LEVEL.get(actual_role, 0)
                if claimed > actual:
                    logger.warning(
                        f"HONEYPOT (org): {my_email} tried accept with "
                        f"claimed_role={body.claimed_role} but actual is {actual_role}"
                    )
                    raise HTTPException(
                        status_code=418,
                        detail=(
                            "Nice try. We noticed the URL tampering. "
                            "If you enjoy finding edge cases, come work with us: "
                            "sameer@dembrane.com"
                        ),
                    )

            org_row = await async_directus.get_item("org", invite_org_id)
            if not org_row or org_row.get("deleted_at"):
                raise HTTPException(status_code=404, detail="Organisation no longer exists")

            # Rate-limit after gates so 4xx blocks don't burn retries.
            await _accept_rate_limiter.check(app_user_id)

            # Fetch active + soft-deleted org_membership rows; pick deterministically.
            existing_org_mem = await async_directus.get_items(
                "org_membership",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": invite_org_id},
                            "user_id": {"_eq": app_user_id},
                        },
                        "fields": ["id", "role", "deleted_at"],
                        "limit": -1,
                    }
                },
            )

            active_row = None
            deleted_row = None
            if isinstance(existing_org_mem, list):
                for row in existing_org_mem:
                    if row.get("deleted_at") is None and active_row is None:
                        active_row = row
                    elif row.get("deleted_at") is not None and deleted_row is None:
                        deleted_row = row

            already_active_member = False
            if active_row is not None:
                already_active_member = True
            elif deleted_row is not None:
                if not await reactivate_membership_row(
                    async_directus,
                    "org_membership",
                    deleted_row["id"],
                    {"deleted_at": None, "role": actual_role},
                ):
                    already_active_member = True
            else:
                if not await create_membership_row(
                    async_directus,
                    "org_membership",
                    {
                        "id": generate_uuid(),
                        "org_id": invite_org_id,
                        "user_id": app_user_id,
                        "role": actual_role,
                    },
                ):
                    already_active_member = True

            await async_directus.update_item(
                "org_invite",
                target_org_invite["id"],
                {"accepted_at": now_iso},
            )

            # Apply union of every other pending invite for (email, org_id) in one click.
            await _consume_pending_invites_in_org(
                email=my_email,
                org_id=invite_org_id,
                app_user_id=app_user_id,
                exclude_org_invite_id=target_org_invite["id"],
            )

            return {
                "status": "already_member" if already_active_member else "success",
                "type": "org",
                "org_id": invite_org_id,
                "org_name": org_row.get("name") or "",
            }

    # Fallback: invite may have already been marked accepted (e.g. via
    # onboarding auto-accept) but the workspace_membership row might be
    # missing — a prior accept that created the accepted_at row but
    # failed to create the membership (partial-write, race, or a Directus
    # error retried by the client) used to dead-end here with "Invite
    # not found or already handled". Now we self-heal: the email match +
    # unforgeable hash is strong enough proof of ownership to create the
    # missing membership and let the user in.
    # SECURITY: filter out revoked rows at the query level so a stale link can't heal a fresh membership.
    if target_invite is None:
        accepted = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": my_email},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "workspace_id",
                        "accepted_at",
                        "deleted_at",
                        "role",
                    ],
                    "limit": -1,
                }
            },
        )
        if isinstance(accepted, list):
            for inv in accepted:
                if not _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                    continue
                if inv.get("deleted_at"):
                    raise HTTPException(status_code=404, detail="Invite not found")
                ws = await async_directus.get_item("workspace", inv["workspace_id"])
                if not ws or ws.get("deleted_at"):
                    raise HTTPException(status_code=404, detail="Workspace no longer exists")

                existing = await async_directus.get_items(
                    "workspace_membership",
                    {
                        "query": {
                            "filter": {
                                "workspace_id": {"_eq": inv["workspace_id"]},
                                "user_id": {"_eq": app_user_id},
                                "deleted_at": {"_null": True},
                            },
                            "fields": ["id"],
                            "limit": 1,
                        }
                    },
                )
                already_member = isinstance(existing, list) and len(existing) > 0
                if already_member:
                    # Per-org sweep: first acceptance consumes all pending invites for (email, org).
                    if ws.get("org_id"):
                        await _consume_pending_invites_in_org(
                            email=my_email,
                            org_id=ws["org_id"],
                            app_user_id=app_user_id,
                            exclude_workspace_invite_id=inv["id"],
                        )
                    return {
                        "status": "already_member",
                        "workspace_id": inv["workspace_id"],
                        "workspace_name": ws.get("name", ""),
                    }

                # Heal the missing membership. Role comes from the invite
                # row — we don't trust any client-provided role here.
                invite_role = inv.get("role") or "member"
                heal_is_external = invite_role == "external"
                logger.warning(
                    "accept-by-hash fallback healed missing workspace_membership "
                    f"for user={app_user_id} invite={inv['id']} ws={inv['workspace_id']}"
                )

                # Race-protection on the heal write. Unified seat pool.
                await assert_can_add_seat(ws, audience="invitee")

                if not heal_is_external and ws.get("org_id"):
                    existing_org_mem = await async_directus.get_items(
                        "org_membership",
                        {
                            "query": {
                                "filter": {
                                    "org_id": {"_eq": ws["org_id"]},
                                    "user_id": {"_eq": app_user_id},
                                    "deleted_at": {"_null": True},
                                },
                                "limit": 1,
                            }
                        },
                    )
                    if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
                        await create_membership_row(
                            async_directus,
                            "org_membership",
                            {
                                "id": generate_uuid(),
                                "org_id": ws["org_id"],
                                "user_id": app_user_id,
                                "role": "member",
                            },
                        )

                # External heal: enforce insider XOR outsider before recreating
                # the external row, so the self-heal path can't bypass the lockdown.
                if heal_is_external and ws.get("org_id"):
                    from dembrane.api.v2._invite_helpers import (
                        reconcile_external_membership_org_row,
                    )

                    await reconcile_external_membership_org_row(
                        ws["org_id"], app_user_id
                    )

                await create_membership_row(
                    async_directus,
                    "workspace_membership",
                    {
                        "id": generate_uuid(),
                        "workspace_id": inv["workspace_id"],
                        "user_id": app_user_id,
                        "role": invite_role,
                        "source": "direct",
                    },
                )
                from dembrane.cache_utils import invalidate_workspace_and_org_usage

                await invalidate_workspace_and_org_usage(inv["workspace_id"], ws.get("org_id"))

                # "healed" tells the frontend to skip the "Joined!" toast (partial-write recovery).
                return {
                    "status": "healed",
                    "type": "workspace",
                    "workspace_id": inv["workspace_id"],
                    "workspace_name": ws.get("name", ""),
                    "org_id": ws.get("org_id"),
                }

        # Org_invite self-heal: mirrors the workspace branch above for partial-write recovery.
        accepted_org = await async_directus.get_items(
            "org_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": my_email},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "org_id",
                        "accepted_at",
                        "deleted_at",
                        "role",
                    ],
                    "limit": -1,
                }
            },
        )
        if isinstance(accepted_org, list):
            from dembrane.api.v2._invite_helpers import ensure_active_org_membership

            for inv in accepted_org:
                if not _hmac.compare_digest(compute_invite_hash(inv["id"]), body.hash):
                    continue
                if inv.get("deleted_at"):
                    raise HTTPException(status_code=404, detail="Invite not found")

                org_rows = await async_directus.get_items(
                    "org",
                    {
                        "query": {
                            "filter": {"id": {"_eq": inv["org_id"]}},
                            "fields": ["id", "name", "deleted_at"],
                            "limit": 1,
                        }
                    },
                )
                org_row = (
                    org_rows[0] if isinstance(org_rows, list) and org_rows else None
                )
                if not org_row or org_row.get("deleted_at"):
                    raise HTTPException(
                        status_code=404, detail="Organisation no longer exists"
                    )

                logger.warning(
                    "accept-by-hash fallback healed missing org_membership "
                    f"for user={app_user_id} invite={inv['id']} org={inv['org_id']}"
                )

                status = await ensure_active_org_membership(
                    org_id=inv["org_id"],
                    user_id=app_user_id,
                    role=inv.get("role") or "member",
                )
                await _consume_pending_invites_in_org(
                    email=my_email,
                    org_id=inv["org_id"],
                    app_user_id=app_user_id,
                    exclude_org_invite_id=inv["id"],
                )
                return {
                    "status": (
                        "already_member" if status == "already_active" else "healed"
                    ),
                    "type": "org",
                    "org_id": inv["org_id"],
                    "org_name": org_row.get("name") or "",
                }

        raise HTTPException(status_code=404, detail="Invite not found or already handled")

    actual_role = target_invite.get("role") or "member"
    is_external_invite = actual_role == "external"

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

    # Race-protection: cap may have shrunk between invite-send and accept.
    # On 402 we return without touching accepted_at, so admin can free a
    # seat and the invitee can retry the same link.
    await assert_can_add_seat(ws, audience="invitee")

    # Rate-limit AFTER all the validation gates above (HMAC match, honeypot,
    # workspace exists, cap check). Brute-force protection still works
    # because guess attempts get a 404 at the HMAC compare stage and never
    # reach this counter; legit invitees retrying past a 402 cap-block
    # don't burn quota waiting for an admin to free a seat.
    await _accept_rate_limiter.check(app_user_id)

    # Invariant (ADR-0003): role='external' ⟺ no org_membership row.
    if not is_external_invite and ws.get("org_id"):
        existing_org_mem = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": ws["org_id"]},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0):
            await create_membership_row(
                async_directus,
                "org_membership",
                {
                    "id": generate_uuid(),
                    "org_id": ws["org_id"],
                    "user_id": app_user_id,
                    "role": "member",
                },
            )

    # External acceptance: enforce insider XOR outsider before creating the
    # external row (same guard as accept_my_invite; the email-link flow must
    # not be a bypass).
    if is_external_invite and ws.get("org_id"):
        from dembrane.api.v2._invite_helpers import (
            reconcile_external_membership_org_row,
        )

        await reconcile_external_membership_org_row(ws["org_id"], app_user_id)

    # Create workspace membership
    existing_ws_mem = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": target_invite["workspace_id"]},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    if not (isinstance(existing_ws_mem, list) and len(existing_ws_mem) > 0):
        if await create_membership_row(
            async_directus,
            "workspace_membership",
            {
                "id": generate_uuid(),
                "workspace_id": target_invite["workspace_id"],
                "user_id": app_user_id,
                "role": actual_role,
                "source": "direct",
            },
        ):
            from dembrane.cache_utils import invalidate_workspace_and_org_usage

            await invalidate_workspace_and_org_usage(target_invite["workspace_id"], ws.get("org_id"))

    await async_directus.update_item(
        "workspace_invite",
        target_invite["id"],
        {
            "accepted_at": now_iso,
        },
    )

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

    # ORGANISATION_MEMBER_ADDED → organisation admins, but only when the invite granted
    # org membership AND the invitee wasn't already on the organisation (i.e.
    # we just created the org_membership row a few lines above).
    if (
        not is_external_invite
        and ws.get("org_id")
        and not (isinstance(existing_org_mem, list) and len(existing_org_mem) > 0)
    ):
        from dembrane.notifications import (
            emit_to_audience,
            audience_organisation_admins,
        )

        organisation_admin_ids = await audience_organisation_admins(ws["org_id"])
        organisation_row = await async_directus.get_item("org", ws["org_id"])
        organisation_name = (organisation_row or {}).get("name") or "the organisation"
        new_member_name = app_user.get("display_name") or my_email or "A new member"
        await emit_to_audience(
            organisation_admin_ids,
            actor_user_id=inviter_id,
            event_code="ORGANISATION_MEMBER_ADDED",
            title=f"{new_member_name} joined {organisation_name}",
            message="They're now a organisation member.",
            action="NAVIGATE_ORGANISATION_SETTINGS",
            ref_org_id=ws["org_id"],
        )

    # WORKSPACE_GUEST_ADDED → workspace admins when an external accepts via
    # the email-link path. Mirror of the same notification on the
    # accept-by-id path. Excludes the inviter and the invitee themselves.
    if is_external_invite:
        from dembrane.notifications import (
            emit_to_audience,
            audience_workspace_admins,
        )

        admin_ids = await audience_workspace_admins(target_invite["workspace_id"])
        admin_ids = [a for a in admin_ids if a != app_user_id and a != inviter_id]
        external_name = app_user.get("display_name") or my_email or "An external"
        ws_name = ws.get("name") or "your workspace"
        await emit_to_audience(
            admin_ids,
            actor_user_id=app_user_id,
            event_code="WORKSPACE_GUEST_ADDED",
            title=f"{external_name} joined {ws_name} as an external",
            message=(
                f"{my_email} now has external access. Externals count against your tier's seat cap."
            ),
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=target_invite["workspace_id"],
            ref_org_id=ws.get("org_id"),
        )

    # Apply every other pending invite for (email, org_id) in one click; external invites skip (no org_id).
    if ws.get("org_id") and not is_external_invite:
        await _consume_pending_invites_in_org(
            email=my_email,
            org_id=ws["org_id"],
            app_user_id=app_user_id,
            exclude_workspace_invite_id=target_invite["id"],
        )

    return {
        "status": "success",
        "type": "workspace",
        "workspace_id": target_invite["workspace_id"],
        "workspace_name": ws.get("name", ""),
        "org_id": ws.get("org_id"),
    }
