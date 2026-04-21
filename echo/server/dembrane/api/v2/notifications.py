"""GET /v2/me/notifications + POST /v2/me/notifications/:id/read.

Inbox BFF. Wraps the `notification` collection so the frontend drawer
can render both announcements and personal notifications with one
component — same shape, same mark-read semantics.

Lives under /v2/me because every row is user-scoped. The underlying
notification table supports cross-team / system notifications; the BFF
restricts reads to the caller's own rows (audience_user_id = me).
"""

from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.notifications")


class NotificationTranslation(BaseModel):
    languages_code: str
    title: str
    message: Optional[str] = None


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
    action: str  # enum from NotificationAction
    level: str   # info | urgent
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    read: bool = False
    actor_user_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_avatar: Optional[str] = None
    refs: NotificationRefs = NotificationRefs()
    translation: Optional[NotificationTranslation] = None


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

    notif_filter: dict = {
        "audience_user_id": {"_eq": app_user["id"]},
        "_or": [
            {"expires_at": {"_null": True}},
            {"expires_at": {"_gt": now_iso}},
        ],
    }

    rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": notif_filter,
                "fields": [
                    "id",
                    "event_code",
                    "action",
                    "level",
                    "created_at",
                    "expires_at",
                    "actor_user_id",
                    "ref_org_id",
                    "ref_workspace_id",
                    "ref_project_id",
                    "ref_chat_id",
                    "ref_report_id",
                    "ref_conversation_id",
                    "ref_invite_id",
                ],
                "sort": ["-created_at"],
                "limit": max(1, min(limit, 200)),
            }
        },
    ) or []
    if not isinstance(rows, list) or not rows:
        return []

    notif_ids = [r["id"] for r in rows if r.get("id")]

    # Read state (activity rows) keyed by notification_id.
    activity_rows = await async_directus.get_items(
        "notification_activity",
        {
            "query": {
                "filter": {
                    "notification_id": {"_in": notif_ids},
                    "user_id": {"_eq": auth.user_id},
                },
                "fields": ["notification_id", "read"],
                "limit": -1,
            }
        },
    ) or []
    read_map: dict[str, bool] = {}
    if isinstance(activity_rows, list):
        for ar in activity_rows:
            nid = ar.get("notification_id")
            if nid:
                read_map[nid] = bool(ar.get("read", False))

    if unread_only:
        rows = [r for r in rows if not read_map.get(r["id"], False)]
        if not rows:
            return []
        notif_ids = [r["id"] for r in rows]

    # Translations — pick the user's language with en-US fallback.
    # Batch once; caller UX doesn't need every locale.
    accept_lang = "en-US"  # TODO: thread Accept-Language through session
    translation_rows = await async_directus.get_items(
        "notification_translations",
        {
            "query": {
                "filter": {"notification_id": {"_in": notif_ids}},
                "fields": ["notification_id", "languages_code", "title", "message"],
                "limit": -1,
            }
        },
    ) or []
    tl_by_notif: dict[str, dict] = {}
    if isinstance(translation_rows, list):
        for tr in translation_rows:
            nid = tr.get("notification_id")
            if not nid:
                continue
            # Prefer user's language; fall back to en-US; any other as
            # final backstop.
            existing = tl_by_notif.get(nid)
            lang = tr.get("languages_code")
            if (
                existing is None
                or lang == accept_lang
                or (lang == "en-US" and existing.get("languages_code") != accept_lang)
            ):
                tl_by_notif[nid] = tr

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
        tl = tl_by_notif.get(r["id"])
        actor = actor_map.get(r.get("actor_user_id") or "") or {}
        out.append(
            NotificationRow(
                id=r["id"],
                event_code=r.get("event_code", ""),
                action=r.get("action", "NONE"),
                level=r.get("level", "info"),
                created_at=r.get("created_at"),
                expires_at=r.get("expires_at"),
                read=read_map.get(r["id"], False),
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
                translation=(
                    NotificationTranslation(
                        languages_code=tl.get("languages_code", ""),
                        title=tl.get("title", ""),
                        message=tl.get("message"),
                    )
                    if tl
                    else None
                ),
            )
        )
    return out


@router.get("/unread-count")
async def unread_count(auth: DependencyDirectusSession) -> dict:
    """Cheap count for the inbox badge.

    Runs a single aggregate — don't call list_notifications just to
    get `len(unread)`.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    # Notifications this user owns that haven't expired yet.
    notif_rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": {
                    "audience_user_id": {"_eq": app_user["id"]},
                    "_or": [
                        {"expires_at": {"_null": True}},
                        {"expires_at": {"_gt": now_iso}},
                    ],
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(notif_rows, list) or not notif_rows:
        return {"unread": 0}
    notif_ids = [r["id"] for r in notif_rows]

    # Activity rows for the caller's read/unread state on those.
    read_rows = await async_directus.get_items(
        "notification_activity",
        {
            "query": {
                "filter": {
                    "notification_id": {"_in": notif_ids},
                    "user_id": {"_eq": auth.user_id},
                    "read": {"_eq": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    ) or []
    read_count = len(read_rows) if isinstance(read_rows, list) else 0
    return {"unread": max(0, len(notif_ids) - read_count)}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Flip the caller's activity row for this notification to read=true.

    Verifies audience — a user can only mark their own rows read, even
    if they guess another user's notification_id.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    notif = await async_directus.get_item("notification", notification_id)
    if not notif or notif.get("audience_user_id") != app_user["id"]:
        raise HTTPException(status_code=404, detail="Notification not found")

    rows = await async_directus.get_items(
        "notification_activity",
        {
            "query": {
                "filter": {
                    "notification_id": {"_eq": notification_id},
                    "user_id": {"_eq": auth.user_id},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        await async_directus.update_item(
            "notification_activity", rows[0]["id"], {"read": True}
        )
    else:
        # Emit normally pre-creates activity; defend in case a row is missing.
        from dembrane.utils import generate_uuid
        await async_directus.create_item(
            "notification_activity",
            {
                "id": generate_uuid(),
                "notification_id": notification_id,
                "user_id": auth.user_id,
                "read": True,
            },
        )
    return {"status": "read"}


@router.post("/read-all")
async def mark_all_read(auth: DependencyDirectusSession) -> dict:
    """Flip every unread activity row for this user to read=true.

    Cap at the 500 most recent to keep the mutation bounded.
    """
    from dembrane.utils import generate_uuid  # noqa: F401 (future use)

    app_user = await get_app_user_or_raise(auth.user_id)

    notif_rows = await async_directus.get_items(
        "notification",
        {
            "query": {
                "filter": {"audience_user_id": {"_eq": app_user["id"]}},
                "fields": ["id"],
                "sort": ["-created_at"],
                "limit": 500,
            }
        },
    ) or []
    if not isinstance(notif_rows, list) or not notif_rows:
        return {"status": "noop", "marked": 0}
    notif_ids = [r["id"] for r in notif_rows]

    activity_rows = await async_directus.get_items(
        "notification_activity",
        {
            "query": {
                "filter": {
                    "notification_id": {"_in": notif_ids},
                    "user_id": {"_eq": auth.user_id},
                    "read": {"_eq": False},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    ) or []
    marked = 0
    if isinstance(activity_rows, list):
        for row in activity_rows:
            await async_directus.update_item(
                "notification_activity", row["id"], {"read": True}
            )
            marked += 1
    return {"status": "read", "marked": marked}
