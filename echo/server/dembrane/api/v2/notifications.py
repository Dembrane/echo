"""GET /v2/me/notifications + mark-read endpoints.

Inbox BFF. Flat `notification` rows keyed to the caller — no parent
or activity sidecars to join. Read state lives inline as `read_at`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.notifications")


class NotificationRefs(BaseModel):
    org_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None
    chat_id: Optional[str] = None
    report_id: Optional[str] = None
    conversation_id: Optional[str] = None
    invite_id: Optional[str] = None


class NotificationRow(BaseModel):
    id: str
    event_code: str
    severity: str  # info | action_required | destructive
    action: str  # NotificationAction enum
    title: str
    message: Optional[str] = None
    scope: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    read: bool = False
    actor_user_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_avatar: Optional[str] = None
    refs: NotificationRefs = NotificationRefs()


def _row_filter(app_user_id: str, now_iso: str) -> dict:
    return {
        "audience_user_id": {"_eq": app_user_id},
        "_or": [
            {"expires_at": {"_null": True}},
            {"expires_at": {"_gt": now_iso}},
        ],
    }


@router.get("", response_model=list[NotificationRow])
async def list_notifications(
    auth: DependencyDirectusSession,
    unread_only: bool = False,
    limit: int = 50,
) -> list[NotificationRow]:
    """User's own notifications, most recent first.

    Expired rows (`expires_at < now`) are filtered server-side so the
    client doesn't have to handle stale items.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    notif_filter = _row_filter(app_user["id"], now_iso)
    if unread_only:
        notif_filter["read_at"] = {"_null": True}

    rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": notif_filter,
                "fields": [
                    "id", "event_code", "severity", "action",
                    "title", "message", "scope", "params",
                    "created_at", "expires_at", "read_at",
                    "actor_user_id",
                    "ref_org_id", "ref_workspace_id", "ref_project_id",
                    "ref_chat_id", "ref_report_id",
                    "ref_conversation_id", "ref_invite_id",
                ],
                "sort": ["-created_at"],
                "limit": max(1, min(limit, 200)),
            }
        },
    ) or []
    if not isinstance(rows, list) or not rows:
        return []

    # Actor name + avatar in one batch.
    actor_ids = list({r.get("actor_user_id") for r in rows if r.get("actor_user_id")})
    actor_map: dict[str, dict] = {}
    if actor_ids:
        app_users = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": actor_ids}},
                    "fields": ["id", "display_name", "directus_user_id"],
                    "limit": -1,
                }
            },
        ) or []
        if isinstance(app_users, list):
            du_ids = [u["directus_user_id"] for u in app_users if u.get("directus_user_id")]
            avatar_map: dict[str, Optional[str]] = {}
            if du_ids:
                profiles = await async_directus.get_users(
                    {
                        "query": {
                            "filter": {"id": {"_in": du_ids}},
                            "fields": ["id", "avatar"],
                            "limit": -1,
                        }
                    }
                )
                if isinstance(profiles, list):
                    avatar_map = {p["id"]: p.get("avatar") for p in profiles}
            for u in app_users:
                actor_map[u["id"]] = {
                    "display_name": u.get("display_name") or "",
                    "avatar": avatar_map.get(u.get("directus_user_id") or "") or None,
                }

    out: list[NotificationRow] = []
    for r in rows:
        actor = actor_map.get(r.get("actor_user_id") or "") or {}
        out.append(
            NotificationRow(
                id=r["id"],
                event_code=r.get("event_code", ""),
                severity=r.get("severity", "info"),
                action=r.get("action", "NONE"),
                title=r.get("title", ""),
                message=r.get("message"),
                scope=r.get("scope"),
                params=r.get("params"),
                created_at=r.get("created_at"),
                expires_at=r.get("expires_at"),
                read=bool(r.get("read_at")),
                actor_user_id=r.get("actor_user_id"),
                actor_name=actor.get("display_name"),
                actor_avatar=actor.get("avatar"),
                refs=NotificationRefs(
                    org_id=r.get("ref_org_id"),
                    workspace_id=r.get("ref_workspace_id"),
                    project_id=r.get("ref_project_id"),
                    chat_id=r.get("ref_chat_id"),
                    report_id=r.get("ref_report_id"),
                    conversation_id=r.get("ref_conversation_id"),
                    invite_id=r.get("ref_invite_id"),
                ),
            )
        )
    return out


@router.get("/unread-count")
async def unread_count(auth: DependencyDirectusSession) -> dict:
    """Cheap count for the inbox badge."""
    app_user = await get_app_user_or_raise(auth.user_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    notif_filter = _row_filter(app_user["id"], now_iso)
    notif_filter["read_at"] = {"_null": True}

    rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": notif_filter,
                "fields": ["id"],
                "limit": -1,
            }
        },
    ) or []
    count = len(rows) if isinstance(rows, list) else 0
    return {"unread": count}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Stamp `read_at` on the caller's notification row.

    Verifies audience — a user can only mark their own rows read, even
    if they guess another user's notification_id.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    notif = await async_directus.get_item("notification", notification_id)
    if not notif or notif.get("audience_user_id") != app_user["id"]:
        raise HTTPException(status_code=404, detail="Notification not found")

    if notif.get("read_at"):
        return {"status": "read"}  # already read — idempotent no-op

    await async_directus.update_item(
        "notification",
        notification_id,
        {"read_at": datetime.now(timezone.utc).isoformat()},
    )
    return {"status": "read"}


@router.post("/read-all")
async def mark_all_read(auth: DependencyDirectusSession) -> dict:
    """Stamp `read_at` on every unread notification for this user.

    Capped at 500 to keep the mutation bounded. Anything older is
    effectively read anyway — the drawer doesn't page back that far.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": {
                    "audience_user_id": {"_eq": app_user["id"]},
                    "read_at": {"_null": True},
                },
                "fields": ["id"],
                "sort": ["-created_at"],
                "limit": 500,
            }
        },
    ) or []
    marked = 0
    if isinstance(rows, list):
        for row in rows:
            await async_directus.update_item(
                "notification", row["id"], {"read_at": now_iso}
            )
            marked += 1
    return {"status": "read", "marked": marked}
