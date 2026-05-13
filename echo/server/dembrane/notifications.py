"""In-app notification service.

One flat `notification` table, one row per `(event, recipient)`. The
announcement-pattern split (parent + translations + activity) was
rejected here because fan-out in this product is almost always 1–3
people — shared-parent dedup buys less than the JOIN cost on every
inbox read.

### Channels

Storage is channel-agnostic. Future delivery layers read the same
rows rather than having their own pipeline:

    emit(...) → notification row (one per recipient)
        └── inbox UI reads via /v2/me/notifications
        └── (future) digest worker groups by user + sends SendGrid
        └── (future) Slack bridge fans out urgent/mentioned rows

Emission sites describe *what happened*, not *where it goes*. Per-
user channel preferences live in the delivery layer, not here.
"""

from __future__ import annotations

from typing import Any, Literal, Optional
from logging import getLogger

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
    "NAVIGATE_ORGANISATION_SETTINGS",
    "NAVIGATE_WORKSPACE_SETTINGS",
]

NotificationSeverity = Literal["info", "action_required", "destructive"]


# Event → severity map. Controls client-side row styling (background
# tint, button style, unread-dot color). Anything not listed defaults
# to "info". Keep in sync with the inbox renderer in
# frontend/src/components/inbox/Inbox.tsx.
_SEVERITY_BY_EVENT: dict[str, NotificationSeverity] = {
    # Access revoked / data lost / feature downgraded
    "WORKSPACE_REMOVED": "destructive",
    "ORGANISATION_REMOVED": "destructive",
    "PROJECT_NOW_PRIVATE": "destructive",
    "PROJECT_SHARE_REVOKED": "destructive",
    "TIER_DOWNGRADED": "destructive",
    "INVITE_CANCELLED": "destructive",
    "REPORT_FAILED": "destructive",
    # Requires user action.
    "MEMBERSHIP_REQUESTED": "action_required",
    # Cap-blocked invites: invitee can't proceed until the admin frees a
    # seat. Marked action_required on the admin side so they see the
    # "you need to act" styling; the invitee side surfaces the stuck
    # state and the retry path.
    "INVITE_BLOCKED_AT_CAP": "action_required",
    "INVITE_PENDING_AT_CAP": "action_required",
    # WORKSPACE_GUEST_ADDED is intentionally NOT in this map — it's a
    # passive "FYI a guest joined your workspace" event with no action
    # required, so it falls through to the default "info" tint.
    # NB: MEMBERSHIP_REQUEST_REJECTED is deliberately absent — matrix §6
    # specifies silent rejection, and emit() is never called for that code.
    # Matrix §10 partner handoff.
    "PARTNER_HANDOFF_PENDING": "action_required",
    # PARTNER_HANDOFF_ACCEPTED defaults to 'info' — no action needed.
}


def severity_for(event_code: str) -> NotificationSeverity:
    return _SEVERITY_BY_EVENT.get(event_code, "info")


async def _compute_scope(
    *,
    ref_org_id: Optional[str],
    ref_workspace_id: Optional[str],
    ref_project_id: Optional[str],
) -> Optional[str]:
    """Build the 'Org › Workspace › Project' breadcrumb from refs.

    Frozen at emit time so a later rename preserves the historical
    breadcrumb on existing rows. Missing names are skipped (we don't
    invent placeholders). Returns None when there's nothing to show.
    """
    parts: list[str] = []
    try:
        if ref_org_id:
            org = await async_directus.get_item("org", ref_org_id)
            if org and org.get("name"):
                parts.append(org["name"])
        if ref_workspace_id:
            ws = await async_directus.get_item("workspace", ref_workspace_id)
            if ws and ws.get("name"):
                parts.append(ws["name"])
        if ref_project_id:
            proj = await async_directus.get_item("project", ref_project_id)
            if proj and proj.get("name"):
                parts.append(proj["name"])
    except Exception as exc:  # noqa: BLE001 — scope is best-effort
        logger.debug("scope computation failed: %s", exc)
    if not parts:
        return None
    return " \u203a ".join(parts)


async def emit(
    *,
    audience_user_id: str,
    event_code: str,
    title: str,
    message: Optional[str] = None,
    action: NotificationAction = "NONE",
    severity: Optional[NotificationSeverity] = None,
    actor_user_id: Optional[str] = None,
    ref_org_id: Optional[str] = None,
    ref_workspace_id: Optional[str] = None,
    ref_project_id: Optional[str] = None,
    ref_chat_id: Optional[str] = None,
    ref_report_id: Optional[str] = None,
    ref_conversation_id: Optional[str] = None,
    ref_invite_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
    scope: Optional[str] = None,
    expires_at: Optional[str] = None,
    # Deprecated alias — old callers pass `level=`, we translate it on
    # the way through until they migrate. Harmless.
    level: Optional[str] = None,
) -> Optional[str]:
    """Create one notification row for the recipient. Returns the
    notification id, or None on failure (never raises — notifications
    are a best-effort side effect, they must not fail the parent
    action).

    Don't call with a list of users — use `emit_to_audience`.

    `severity` defaults from `severity_for(event_code)` when omitted.
    `scope` is computed from refs when omitted.
    `params` is forward-compat metadata for client-rendered i18n.
    """
    try:
        resolved_severity: NotificationSeverity = severity or severity_for(event_code)
        # Silently accept `level=` from legacy callers.
        if level and not severity:
            # Old "urgent" maps onto action_required in the new spec.
            resolved_severity = "action_required" if level == "urgent" else "info"

        resolved_scope = scope
        if resolved_scope is None:
            resolved_scope = await _compute_scope(
                ref_org_id=ref_org_id,
                ref_workspace_id=ref_workspace_id,
                ref_project_id=ref_project_id,
            )

        notification_id = generate_uuid()
        await async_directus.create_item(
            "notification",
            {
                "id": notification_id,
                "audience_user_id": audience_user_id,
                "actor_user_id": actor_user_id,
                "event_code": event_code,
                "severity": resolved_severity,
                "action": action,
                "title": title,
                "message": message,
                "scope": resolved_scope,
                "params": params,
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
        return notification_id
    except Exception as exc:  # noqa: BLE001 — notifications must never raise
        # audience_user_id omitted: CodeQL flags it as sensitive.
        logger.warning(
            "emit notification failed (event=%s): %s",
            event_code,
            exc,
        )
        return None


# ── Audience derivation helpers ─────────────────────────────────────────


async def audience_workspace_admins(workspace_id: str) -> list[str]:
    """Return app_user.id for every admin/owner on a workspace (direct
    + derived organisation admins). Use for "someone joined your workspace"-
    shaped notifications.
    """
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(workspace_id)
    return [
        m["user_id"] for m in members if m.get("user_id") and m.get("role") in ("admin", "owner")
    ]


async def audience_workspace_members(workspace_id: str) -> list[str]:
    """Every effective member on the workspace, any role."""
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(workspace_id)
    return [m["user_id"] for m in members if m.get("user_id")]


async def audience_workspace_admins_and_billing(workspace_id: str) -> list[str]:
    """Admin/owner + billing roles on the workspace.

    Matrix v1.1 §3 downgrade audience: every admin + billing-role user on
    the workspace. Matrix v1.1 §11 upgrade-request co-admin notify audience.
    """
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(workspace_id)
    return [
        m["user_id"]
        for m in members
        if m.get("user_id") and m.get("role") in ("admin", "owner", "billing")
    ]


async def audience_organisation_admins(org_id: str) -> list[str]:
    rows = (
        await async_directus.get_items(
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
        )
        or []
    )
    if not isinstance(rows, list):
        return []
    return [r["user_id"] for r in rows if r.get("user_id")]


async def audience_organisation(org_id: str) -> list[str]:
    rows = (
        await async_directus.get_items(
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
        )
        or []
    )
    if not isinstance(rows, list):
        return []
    return [r["user_id"] for r in rows if r.get("user_id")]


async def emit_to_audience(
    audience_user_ids: list[str],
    **emit_kwargs: Any,
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


def emit_sync(**emit_kwargs: Any) -> Optional[str]:
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
        # audience_user_id omitted: CodeQL flags it as sensitive.
        logger.warning(
            "emit_sync failed (event=%s): %s",
            emit_kwargs.get("event_code"),
            exc,
        )
        return None
