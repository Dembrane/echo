"""POST /v2/invites/{id}/resend and DELETE /v2/invites/{id}: unified across workspace_invite and org_invite."""

from __future__ import annotations

from typing import Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException

from dembrane.app_user import get_app_user_or_raise
from dembrane.settings import get_settings
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.invites import compute_invite_hash, _enqueue_invite_email
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.invite_actions")

# 10/hour per inviter; tighter than invite-creation because resends are an amplification vector.
_resend_rate_limiter = create_user_rate_limiter(
    name="invite_resend", capacity=10, window_seconds=3600
)


async def _user_is_org_admin(org_id: str, app_user_id: str) -> bool:
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                    "role": {"_in": ["admin", "owner"]},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and len(rows) > 0


async def _user_is_org_member(org_id: str, app_user_id: str) -> bool:
    """True iff the caller has a live (non-soft-deleted) org_membership.

    The is_inviter check on its own is not enough: a user removed from
    the org should not retain the ability to drive invites they sent
    while they were still a member. Pair this with is_inviter so a live
    inviter still passes when they're a non-admin member.
    """
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and len(rows) > 0


async def _workspace_org_id(workspace_id: str) -> Optional[str]:
    """Resolve workspace_id → org_id.

    Returns the org_id even when the workspace is soft-deleted, so the
    admin can still revoke pending invites issued before the workspace
    went away. The previous version returned None on soft-delete, which
    meant a soft-deleted workspace's pending invites were visible in
    the admin list but unrevokable (404'd at this lookup).
    """
    row = await async_directus.get_item("workspace", workspace_id)
    if not row:
        return None
    return row.get("org_id")


async def _load_invite(invite_id: str) -> tuple[Optional[str], Optional[dict]]:
    """Resolve invite_id → (type, row).

    Returns ("workspace", row) or ("org", row) or (None, None) when the
    id matches no live (non-deleted) invite. Soft-deleted rows are
    treated as not found (same as a hard delete from the caller's POV).

    Workspace_invite is probed first because it's the hot path — every
    other dual-table read in this codebase (me.py accept-by-hash,
    auth.py public probe) checks workspace_invite first. Keeping the
    order consistent avoids surprise when chasing a bug across files.

    Uses a filter-based list query rather than get_item: Directus's
    single-item endpoint returns FORBIDDEN (not 404) for non-existent
    IDs to avoid leaking existence, which would otherwise turn a
    cross-table probe into a 500.
    """
    ws_rows = await async_directus.get_items(
        "workspace_invite",
        {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
    )
    if isinstance(ws_rows, list) and ws_rows:
        row = ws_rows[0]
        if not row.get("deleted_at"):
            return "workspace", row

    org_rows = await async_directus.get_items(
        "org_invite",
        {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
    )
    if isinstance(org_rows, list) and org_rows:
        row = org_rows[0]
        if not row.get("deleted_at"):
            return "org", row

    return None, None


@router.post("/{invite_id}/resend")
async def resend_invite(
    invite_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Resend the invite email and extend `expires_at` by 7 days.

    Works for either invite type. Permitted callers: the original
    inviter, or an org admin/owner of the org the invite belongs to.
    Rate-limited 10/hour per caller.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    invite_type, invite = await _load_invite(invite_id)
    if not invite_type or not invite:
        raise HTTPException(status_code=404, detail="Invite not found")

    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite has already been accepted")

    # Resolve the org scope so we can run the permission check.
    if invite_type == "org":
        org_id = invite.get("org_id")
    else:
        org_id = await _workspace_org_id(invite.get("workspace_id") or "")
    if not org_id:
        raise HTTPException(status_code=404, detail="Invite not found")

    # Require live org_membership: a former admin shouldn't retain resend power after removal.
    is_inviter = invite.get("invited_by") == app_user["id"]
    is_org_admin = await _user_is_org_admin(org_id, app_user["id"])
    if is_inviter and not is_org_admin:
        is_inviter = await _user_is_org_member(org_id, app_user["id"])
    if not (is_inviter or is_org_admin):
        raise HTTPException(status_code=403, detail="Only the inviter or an org admin can resend")

    await _resend_rate_limiter.check(app_user["id"])

    settings = get_settings()

    new_expires = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    table = "org_invite" if invite_type == "org" else "workspace_invite"
    await async_directus.update_item(table, invite_id, {"expires_at": new_expires})

    # Resolve inviter display name + org/workspace name for the email.
    inviter_name = app_user.get("display_name") or "Your organisation"
    org_row = await async_directus.get_item("org", org_id)
    org_name = (org_row or {}).get("name") or "your organisation"

    email = (invite.get("email") or "").lower()
    role = invite.get("role") or "member"

    from urllib.parse import urlencode

    invite_hash = compute_invite_hash(invite_id)

    if invite_type == "org":
        ctx_params = urlencode(
            {
                "iss": inviter_name,
                "org": org_name,
                "role": role,
                "email": email,
                "h": invite_hash,
            }
        )
        invite_url = f"{settings.urls.admin_base_url}/invite/accept?{ctx_params}"
        email_queued = _enqueue_invite_email(
            to=email,
            subject=f"{inviter_name} invited you to {org_name} on dembrane",
            template="org_invite",
            template_data={
                "inviter_name": inviter_name,
                "org_name": org_name,
                "role": role,
                "invite_url": invite_url,
            },
            failure_context=f"resend org_invite / org {org_id}",
        )
    else:
        ws_row = await async_directus.get_item("workspace", invite.get("workspace_id") or "")
        workspace_name = (ws_row or {}).get("name") or "a workspace"
        ctx_params = urlencode(
            {
                "iss": inviter_name,
                "ws": workspace_name,
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
                "workspace_name": workspace_name,
                "invite_url": invite_url,
            },
            failure_context=f"resend workspace_invite / invite {invite_id}",
        )

    logger.info(
        f"Resent {invite_type} invite {invite_id} to {email} by {app_user['id']} "
        f"(email_queued: {email_queued})"
    )
    return {"status": "success", "email_sent": email_queued, "type": invite_type}


async def _load_invite_including_deleted(
    invite_id: str,
) -> tuple[Optional[str], Optional[dict]]:
    """Variant of _load_invite that returns soft-deleted rows too. Used
    by revoke so a repeat click on an already-deleted row returns 200
    idempotent instead of 404 — the frontend's optimistic update treats
    revoke as idempotent and a 404 surfaces as a stray toast error.
    """
    ws_rows = await async_directus.get_items(
        "workspace_invite",
        {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
    )
    if isinstance(ws_rows, list) and ws_rows:
        return "workspace", ws_rows[0]

    org_rows = await async_directus.get_items(
        "org_invite",
        {"query": {"filter": {"id": {"_eq": invite_id}}, "limit": 1}},
    )
    if isinstance(org_rows, list) and org_rows:
        return "org", org_rows[0]

    return None, None


@router.delete("/{invite_id}")
async def revoke_invite(
    invite_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Soft-delete a pending invite by setting `deleted_at`.

    Works for either invite type. Permitted callers: the original
    inviter, or an org admin/owner of the org the invite belongs to.
    Idempotent: a second call against an already-deleted invite returns
    200 with `status="already_revoked"` so the frontend's optimistic
    update doesn't surface a toast error after the cache invalidated.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    # Include soft-deleted rows so we can return idempotent success.
    invite_type, invite = await _load_invite_including_deleted(invite_id)
    if not invite_type or not invite:
        raise HTTPException(status_code=404, detail="Invite not found")

    if invite.get("accepted_at"):
        raise HTTPException(status_code=400, detail="Invite has already been accepted")

    if invite_type == "org":
        org_id = invite.get("org_id")
    else:
        org_id = await _workspace_org_id(invite.get("workspace_id") or "")
    if not org_id:
        raise HTTPException(status_code=404, detail="Invite not found")

    # Permission check runs even for already-deleted rows to prevent ID fingerprinting.
    is_inviter = invite.get("invited_by") == app_user["id"]
    is_org_admin = await _user_is_org_admin(org_id, app_user["id"])
    if is_inviter and not is_org_admin:
        is_inviter = await _user_is_org_member(org_id, app_user["id"])
    if not (is_inviter or is_org_admin):
        raise HTTPException(status_code=403, detail="Only the inviter or an org admin can revoke")

    if invite.get("deleted_at"):
        return {"status": "already_revoked", "type": invite_type}

    table = "org_invite" if invite_type == "org" else "workspace_invite"
    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item(table, invite_id, {"deleted_at": now_iso})

    logger.info(f"Revoked {invite_type} invite {invite_id} by {app_user['id']}")
    return {"status": "success", "type": invite_type}
