"""In-app notification service.

One canonical store (`notification` + `notification_translations` +
`notification_activity`) serves the inbox UI today. The module exposes a
single `emit` function that action code paths call — everything else
(list, mark-read, unread-count) runs through `/v2/me/notifications` BFF
endpoints.

### Channels

Notifications are stored here. Future delivery layers (email digest,
Slack webhook) read from this store rather than having their own
pipeline:

    emit(...) → notification row + activity row
        └── inbox UI reads via /v2/me/notifications
        └── (future) digest worker groups by user + sends SendGrid
        └── (future) Slack bridge fans out urgent/mentioned rows

This keeps the emission sites dumb — they describe *what happened*, not
*where it goes*. Per-user channel preferences live in the delivery
layer, not here. Don't add per-channel booleans to the notification row.
"""

from __future__ import annotations

from logging import getLogger
from typing import Literal, Optional

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.notifications")


NotificationAction = Literal[
    "NONE",
    "NAVIGATE_WS",
    "NAVIGATE_PROJECT",
    "NAVIGATE_REPORT",
    "NAVIGATE_CHAT",
    "NAVIGATE_INVITE",
    "NAVIGATE_TEAM_SETTINGS",
    "NAVIGATE_WORKSPACE_SETTINGS",
]

NotificationLevel = Literal["info", "urgent"]


async def emit(
    *,
    audience_user_id: str,
    event_code: str,
    title: str,
    message: str,
    action: NotificationAction = "NONE",
    level: NotificationLevel = "info",
    actor_user_id: Optional[str] = None,
    ref_org_id: Optional[str] = None,
    ref_workspace_id: Optional[str] = None,
    ref_project_id: Optional[str] = None,
    ref_chat_id: Optional[str] = None,
    ref_report_id: Optional[str] = None,
    ref_conversation_id: Optional[str] = None,
    ref_invite_id: Optional[str] = None,
    language: str = "en-US",
    expires_at: Optional[str] = None,
) -> Optional[str]:
    """Create a single notification row + its English translation +
    one pre-filled activity row. Returns the notification id, or None
    on failure (never raises — notifications are a best-effort side
    effect, they must not fail the parent action).

    Don't call this with a list of users — call once per user. The
    activity row is created eagerly so unread counts can be a cheap
    aggregate.

    ### Translations

    For the first pass we only write one translation row (caller's
    language or en-US). The frontend drawer falls back to en-US when
    the user's locale has no row. When we ship server-side message
    templating (grouped into dembrane/notification_templates.py), we
    can fan out every language in one call.
    """
    try:
        notification_id = generate_uuid()

        # Resolve audience_user_id (app_user.id) → directus_user_id so
        # activity rows match the announcement_activity convention
        # (user_id on activity = directus_users.id).
        directus_user_id: Optional[str] = None
        audience_row = await async_directus.get_item("app_user", audience_user_id)
        if audience_row:
            directus_user_id = audience_row.get("directus_user_id")

        await async_directus.create_item(
            "notification",
            {
                "id": notification_id,
                "audience_user_id": audience_user_id,
                "actor_user_id": actor_user_id,
                "event_code": event_code,
                "action": action,
                "level": level,
                "ref_org_id": ref_org_id,
                "ref_workspace_id": ref_workspace_id,
                "ref_project_id": ref_project_id,
                "ref_chat_id": ref_chat_id,
                "ref_report_id": ref_report_id,
                "ref_conversation_id": ref_conversation_id,
                "ref_invite_id": ref_invite_id,
                "expires_at": expires_at,
            },
        )

        await async_directus.create_item(
            "notification_translations",
            {
                "id": generate_uuid(),
                "notification_id": notification_id,
                "languages_code": language,
                "title": title,
                "message": message,
            },
        )

        if directus_user_id:
            await async_directus.create_item(
                "notification_activity",
                {
                    "id": generate_uuid(),
                    "notification_id": notification_id,
                    "user_id": directus_user_id,
                    "read": False,
                },
            )

        return notification_id
    except Exception as exc:  # noqa: BLE001 — notifications must never raise
        logger.warning(
            "emit notification failed (event=%s audience=%s): %s",
            event_code, audience_user_id, exc,
        )
        return None


# ── Audience derivation helpers ─────────────────────────────────────────

async def audience_workspace_admins(workspace_id: str) -> list[str]:
    """Return app_user.id for every admin/owner on a workspace (direct
    + derived team admins). Use for "someone joined your workspace"-
    shaped notifications.
    """
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(workspace_id)
    return [
        m["user_id"]
        for m in members
        if m.get("user_id") and m.get("role") in ("admin", "owner")
    ]


async def audience_workspace_members(workspace_id: str) -> list[str]:
    """Every effective member on the workspace, any role."""
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(workspace_id)
    return [m["user_id"] for m in members if m.get("user_id")]


async def audience_team_admins(org_id: str) -> list[str]:
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "role": {"_in": ["admin", "owner"]},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(rows, list):
        return []
    return [r["user_id"] for r in rows if r.get("user_id")]


async def audience_team(org_id: str) -> list[str]:
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(rows, list):
        return []
    return [r["user_id"] for r in rows if r.get("user_id")]


async def emit_to_audience(
    audience_user_ids: list[str],
    **emit_kwargs,
) -> list[str]:
    """Fan out the same notification to every user in `audience_user_ids`.

    Skips the actor to avoid "you accepted your own invite" self-notifs
    when `actor_user_id` is in the audience list.
    """
    actor = emit_kwargs.get("actor_user_id")
    created: list[str] = []
    for uid in audience_user_ids:
        if actor and uid == actor:
            continue
        nid = await emit(audience_user_id=uid, **emit_kwargs)
        if nid:
            created.append(nid)
    return created


# ── Sync bridge for Dramatiq actors ──────────────────────────────────────


def emit_sync(**emit_kwargs) -> Optional[str]:
    """Blocking variant for Dramatiq actors that can't await.

    Dramatiq workers run sync code; async frameworks can't be called
    directly. CLAUDE.md's rule is to use `run_async_in_new_loop` rather
    than nesting event loops. Catch-all on exceptions mirrors `emit` —
    notifications are best-effort.
    """
    try:
        from dembrane.async_helpers import run_async_in_new_loop
        return run_async_in_new_loop(emit(**emit_kwargs))
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "emit_sync failed (event=%s audience=%s): %s",
            emit_kwargs.get("event_code"),
            emit_kwargs.get("audience_user_id"),
            exc,
        )
        return None
