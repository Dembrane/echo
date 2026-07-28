"""Staff support access: audit events, request state machine, notifications.

Every lifecycle change goes through record_support_access_event(), which
appends the audit row and fans out the in-app notification and email.
"""

from __future__ import annotations

from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.support_access")

EVENT_COLLECTION = "support_access_event"
REQUEST_COLLECTION = "support_access_request"

REQUEST_TTL = timedelta(days=7)
REMINDER_INTERVAL = timedelta(days=7)
SUPPORT_ACCESS_TTL = timedelta(hours=24)

EVENT_TOGGLE_ENABLED = "toggle_enabled"
EVENT_TOGGLE_DISABLED = "toggle_disabled"
EVENT_TOGGLE_AUTO_DISABLED = "toggle_auto_disabled"
EVENT_REQUEST_CREATED = "request_created"
EVENT_REQUEST_APPROVED = "request_approved"
EVENT_REQUEST_DENIED = "request_denied"
EVENT_REQUEST_EXPIRED = "request_expired"
EVENT_REQUEST_CANCELLED = "request_cancelled"
EVENT_STAFF_JOINED = "staff_joined"
EVENT_STAFF_EXTENDED = "staff_extended"
EVENT_STAFF_LEFT = "staff_left"
EVENT_STAFF_AUTO_REVOKED = "staff_auto_revoked"
EVENT_REMINDER_SENT = "reminder_sent"


# ── shared 24h grant helper ──────────────────────────────────────────────────


async def _reresolve_membership_after_join_race(
    workspace_id: str, app_user_id: str, expires_iso: str
) -> tuple[Optional[str], Optional[tuple[str, str, Optional[str]]]]:
    """A concurrent join won the race: re-read the persisted row so we never
    schedule a revoke against an id we failed to insert."""
    from fastapi import HTTPException

    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "role", "source"],
                "limit": 1,
            }
        },
    )
    row = rows[0] if isinstance(rows, list) and rows else None
    if row is None:
        raise HTTPException(
            status_code=409, detail="Membership changed concurrently, please retry."
        )
    if row.get("source") != "staff_support":
        return None, ("already_member", str(row["id"]), None)
    membership_id = str(row["id"])
    await async_directus.update_item(
        "workspace_membership", membership_id, {"expires_at": expires_iso}
    )
    return membership_id, None


async def grant_support_membership(
    *, workspace_id: str, app_user_id: str, org_id: Optional[str]
) -> tuple[str, str, Optional[str]]:
    """Create / reactivate / extend a 24h staff_support membership and (re)arm
    its revoke task. Returns (status, membership_id, expires_iso)."""
    from dembrane.cache_utils import invalidate_workspace_and_org_usage
    from dembrane.scheduled_tasks import (
        TASK_REVOKE_STAFF_SUPPORT,
        schedule_task,
        cancel_pending_tasks,
    )
    from dembrane.api.v2._invite_helpers import (
        create_membership_row,
        reactivate_membership_row,
    )

    now = datetime.now(timezone.utc)
    expires_at = now + SUPPORT_ACCESS_TTL
    expires_iso = expires_at.isoformat()

    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                },
                "fields": ["id", "role", "source", "deleted_at"],
                "limit": -1,
            }
        },
    )
    active_row = None
    deleted_row = None
    if isinstance(rows, list):
        for row in rows:
            if row.get("deleted_at") is None and active_row is None:
                active_row = row
            elif row.get("deleted_at") is not None and deleted_row is None:
                deleted_row = row

    if active_row is not None and active_row.get("source") != "staff_support":
        return ("already_member", str(active_row["id"]), None)

    if active_row is not None:
        membership_id = str(active_row["id"])
        await async_directus.update_item(
            "workspace_membership", membership_id, {"expires_at": expires_iso}
        )
        status = "extended"
    elif deleted_row is not None:
        membership_id = str(deleted_row["id"])
        reactivated = await reactivate_membership_row(
            async_directus,
            "workspace_membership",
            membership_id,
            {
                "deleted_at": None,
                "role": "admin",
                "source": "staff_support",
                "expires_at": expires_iso,
            },
        )
        if not reactivated:
            resolved_id, raced = await _reresolve_membership_after_join_race(
                workspace_id, app_user_id, expires_iso
            )
            if raced is not None:
                return raced
            assert resolved_id is not None
            membership_id = resolved_id
        status = "joined"
    else:
        membership_id = generate_uuid()
        created = await create_membership_row(
            async_directus,
            "workspace_membership",
            {
                "id": membership_id,
                "workspace_id": workspace_id,
                "user_id": app_user_id,
                "role": "admin",
                "source": "staff_support",
                "expires_at": expires_iso,
            },
        )
        if not created:
            resolved_id, raced = await _reresolve_membership_after_join_race(
                workspace_id, app_user_id, expires_iso
            )
            if raced is not None:
                return raced
            assert resolved_id is not None
            membership_id = resolved_id
        status = "joined"

    await cancel_pending_tasks(
        task_type=TASK_REVOKE_STAFF_SUPPORT,
        payload_match={"membership_id": membership_id},
    )
    await schedule_task(
        task_type=TASK_REVOKE_STAFF_SUPPORT,
        scheduled_at=expires_at,
        payload={
            "workspace_id": workspace_id,
            "membership_id": membership_id,
            "org_id": org_id,
        },
    )
    await invalidate_workspace_and_org_usage(workspace_id, org_id)
    return (status, membership_id, expires_iso)


# ── audit event choke point ──────────────────────────────────────────────────


async def record_support_access_event(
    *,
    workspace_id: str,
    event_code: str,
    actor_user_id: Optional[str] = None,
    staff_user_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
    notify: bool = True,
) -> Optional[str]:
    """Append one audit row and (optionally) fan out its notification + email.
    Best-effort: never raises, so it can't roll back the committed primary
    action. Returns the event id, or None when the write failed."""
    event_id: Optional[str] = None
    try:
        event_id = generate_uuid()
        await async_directus.create_item(
            EVENT_COLLECTION,
            {
                "id": event_id,
                "workspace_id": workspace_id,
                "event_code": event_code,
                "actor_user_id": actor_user_id,
                "staff_user_id": staff_user_id,
                "params": params or {},
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.warning(
            "support_access_event write failed (event=%s ws=%s): %s",
            event_code,
            workspace_id,
            exc,
        )
        event_id = None
    if notify:
        try:
            await send_support_access_notice(
                workspace_id=workspace_id,
                event_code=event_code,
                actor_user_id=actor_user_id,
                staff_user_id=staff_user_id,
                params=params,
            )
        except Exception as exc:  # noqa: BLE001 — notifications are best-effort
            logger.warning(
                "support_access notice failed (event=%s ws=%s): %s",
                event_code,
                workspace_id,
                exc,
            )
    return event_id


async def send_support_access_notice(
    *,
    workspace_id: str,
    event_code: str,
    actor_user_id: Optional[str] = None,
    staff_user_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
) -> None:
    """Fan out the notification + email for one lifecycle event. Public so the
    revoke paths can send the "staff left" notice without a second audit row."""
    from dembrane.email import send_email
    from dembrane.notifications import (
        emit,
        emit_to_audience,
        audience_workspace_admins,
    )

    # Customer's own toggle flips are audit-only.
    if event_code in (EVENT_TOGGLE_ENABLED, EVENT_TOGGLE_DISABLED):
        return

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws:
        return
    ws_name = ws.get("name") or "your workspace"
    org_id = ws.get("org_id")
    url = _settings_url(workspace_id)
    p = params or {}

    if event_code == EVENT_REQUEST_CREATED:
        staff_name = await _display_name(staff_user_id) or "dembrane staff"
        note = (p.get("message") or "").strip()
        admins = await audience_workspace_admins(workspace_id)
        title = f"dembrane staff requested access to {ws_name}"
        message = f"{staff_name} asked to join this workspace for support."
        if note:
            message = f"{message} Note: {note}"
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_REQUESTED",
            title=title,
            message=f"{message} Approve or deny in workspace settings.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_request",
                template_data={
                    "workspace_name": ws_name,
                    "staff_name": staff_name,
                    "note": note,
                    "settings_url": url,
                },
            )
        return

    if event_code == EVENT_STAFF_JOINED:
        staff_name = await _display_name(staff_user_id) or "dembrane staff"
        admins = await audience_workspace_admins(workspace_id)
        title = f"dembrane staff joined {ws_name} for support"
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_JOINED",
            title=title,
            message="Access ends automatically after 24 hours.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_joined",
                template_data={
                    "workspace_name": ws_name,
                    "staff_name": staff_name,
                    "settings_url": url,
                },
            )
        return

    if event_code == EVENT_STAFF_EXTENDED:
        admins = await audience_workspace_admins(workspace_id)
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_EXTENDED",
            title=f"dembrane staff extended their support session in {ws_name}",
            message="The session ends 24 hours from now.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        return

    if event_code in (EVENT_STAFF_LEFT, EVENT_STAFF_AUTO_REVOKED):
        # Only reached when auto-off did not fire (another session still active).
        admins = await audience_workspace_admins(workspace_id)
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_LEFT",
            title=f"A dembrane staff member left {ws_name}",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        return

    if event_code == EVENT_TOGGLE_AUTO_DISABLED:
        admins = await audience_workspace_admins(workspace_id)
        title = f"Support access to {ws_name} turned off"
        message = (
            "The support session ended and staff access was turned off. "
            "Turn it back on in workspace settings if you need more help."
        )
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_ENDED",
            title=title,
            message=message,
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_ended",
                template_data={"workspace_name": ws_name, "settings_url": url},
            )
        return

    if event_code == EVENT_REMINDER_SENT:
        admins = await audience_workspace_admins(workspace_id)
        title = f"Support access to {ws_name} is still on"
        message = (
            "No staff joined in the last 7 days. Turn it off in workspace "
            "settings if you no longer need help."
        )
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_REMINDER",
            title=title,
            message=message,
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_reminder",
                template_data={"workspace_name": ws_name, "settings_url": url},
            )
        return

    if event_code in (EVENT_REQUEST_APPROVED, EVENT_REQUEST_DENIED):
        if not staff_user_id:
            return
        decision = "approved" if event_code == EVENT_REQUEST_APPROVED else "denied"
        title = f"Access request for {ws_name} {decision}"
        await emit(
            audience_user_id=staff_user_id,
            event_code=(
                "SUPPORT_REQUEST_APPROVED"
                if decision == "approved"
                else "SUPPORT_REQUEST_DENIED"
            ),
            title=title,
            message=(
                "You have admin access for 24 hours." if decision == "approved" else None
            ),
            actor_user_id=actor_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        emails = await _emails_for_app_users([staff_user_id])
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_request_resolved",
                template_data={
                    "workspace_name": ws_name,
                    "decision": decision,
                    "workspace_url": _workspace_url(workspace_id),
                },
            )
        return

    if event_code == EVENT_REQUEST_EXPIRED:
        if not staff_user_id:
            return
        await emit(
            audience_user_id=staff_user_id,
            event_code="SUPPORT_REQUEST_EXPIRED",
            title=f"Access request for {ws_name} expired",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        return

    if event_code == EVENT_REQUEST_CANCELLED:
        # Only the toggle-on supersede notifies; self-cancel passes notify=False.
        if p.get("reason") != "toggle_enabled" or not staff_user_id:
            return
        await emit(
            audience_user_id=staff_user_id,
            event_code="SUPPORT_REQUEST_SUPERSEDED",
            title=f"Support access for {ws_name} is now on",
            message="You can join directly from the admin console.",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        return

    logger.debug("no notice mapping for support access event %s", event_code)


# ── toggle-on supersede + auto-off ──────────────────────────────────────────


async def cancel_pending_requests_for_toggle_on(
    *, workspace_id: str, actor_user_id: Optional[str]
) -> int:
    """Toggle turned on: cancel pending requests (staff can join directly) and
    tell each requester. Returns the count superseded."""
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    rows = await async_directus.get_items(
        REQUEST_COLLECTION,
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "status": {"_eq": "pending"},
                },
                "fields": ["id", "requested_by"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    for row in rows:
        request_id = str(row["id"])
        await async_directus.update_item(
            REQUEST_COLLECTION,
            request_id,
            {"status": "cancelled", "resolved_at": now_iso, "resolved_by": actor_user_id},
        )
        await cancel_pending_tasks(
            task_type=TASK_EXPIRE_SUPPORT_REQUEST,
            payload_match={"request_id": request_id},
        )
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_REQUEST_CANCELLED,
            actor_user_id=actor_user_id,
            staff_user_id=row.get("requested_by"),
            params={"request_id": request_id, "reason": "toggle_enabled"},
        )
    return len(rows)


async def maybe_auto_disable_support_access(*, workspace_id: str) -> bool:
    """When the last active staff_support session ends, turn the toggle off,
    cancel reminder timers, and record toggle_auto_disabled. Returns True when
    flipped. Toggle-first check keeps concurrent revokes idempotent."""
    from dembrane.inheritance import membership_access_expired
    from dembrane.scheduled_tasks import TASK_SUPPORT_TOGGLE_REMINDER, cancel_pending_tasks

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or not ws.get("allow_support_access"):
        return False
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "source": {"_eq": "staff_support"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "expires_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    active = [r for r in rows if not membership_access_expired(r.get("expires_at"))]
    if active:
        return False
    await async_directus.update_item(
        "workspace", workspace_id, {"allow_support_access": False}
    )
    await cancel_pending_tasks(
        task_type=TASK_SUPPORT_TOGGLE_REMINDER,
        payload_match={"workspace_id": workspace_id},
    )
    await record_support_access_event(
        workspace_id=workspace_id, event_code=EVENT_TOGGLE_AUTO_DISABLED
    )
    return True


# ── helpers ──────────────────────────────────────────────────────────────────


async def _emails_for_app_users(user_ids: list[str]) -> list[str]:
    if not user_ids:
        return []
    rows = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["email"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return sorted({(r.get("email") or "").strip() for r in rows if r.get("email")})


async def _display_name(app_user_id: Optional[str]) -> str:
    if not app_user_id:
        return ""
    try:
        row = await async_directus.get_item("app_user", app_user_id)
    except Exception:  # noqa: BLE001 — cosmetic lookup
        return ""
    return (row or {}).get("display_name") or ""


def _settings_url(workspace_id: str) -> str:
    from dembrane.settings import get_settings

    base = (get_settings().urls.admin_base_url or "").rstrip("/")
    path = f"/w/{workspace_id}/settings/general"
    return f"{base}{path}" if base else path


def _workspace_url(workspace_id: str) -> str:
    from dembrane.settings import get_settings

    base = (get_settings().urls.admin_base_url or "").rstrip("/")
    path = f"/w/{workspace_id}/home"
    return f"{base}{path}" if base else path
