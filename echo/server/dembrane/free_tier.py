"""Free-tier gating: limit constants, the 402 contract, and the workspace /
org scoped counters and resolvers shared by all four free-tier gates
(transcripts, chat, reports, workspaces).

Gating applies only when tier == "free" exactly. None (legacy workspaces with
no billing account) and paid tiers are never gated. Tier lives on
billing_account; resolve it via dembrane.billing_account.resolve_workspace_tier.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from dembrane import directus_async
from dembrane.tier_capacity import is_conversation_locked

FREE_TIER = "free"

# Per-workspace limits (chats, reports, unlocked transcripts) and the
# per-chat turn limit. Workspaces are limited per org. Named so product can
# tune them in one place.
FREE_TIER_MAX_UNLOCKED_CONVERSATIONS = 1
FREE_TIER_MAX_CHATS = 1
FREE_TIER_MAX_CHAT_USER_TURNS = 3  # the 4th user message hits the upgrade path
FREE_TIER_MAX_REPORTS = 1
FREE_TIER_MAX_WORKSPACES = 1  # per org

# Shared 402 contract. The frontend keys on error == FREE_TIER_LIMIT.
FREE_TIER_LIMIT_ERROR = "FREE_TIER_LIMIT"
# The single purchasable tier today (see dembrane.tier_capacity PURCHASABLE_TIER
# and frontend PURCHASABLE_TIERS).
FREE_TIER_UPGRADE_CTA_TIER = "changemaker"


def is_free_tier(tier: Optional[str]) -> bool:
    """True only for the literal free tier. None and paid tiers are not gated."""
    return tier == FREE_TIER


def free_tier_limit_error(limit: str) -> HTTPException:
    """Build the shared 402 raised when a free-tier limit is hit.

    `limit` is one of: "chats", "chat_turns", "report", "workspaces".
    """
    return HTTPException(
        status_code=402,
        detail={
            "error": FREE_TIER_LIMIT_ERROR,
            "limit": limit,
            "upgrade_cta_tier": FREE_TIER_UPGRADE_CTA_TIER,
        },
    )


async def _agg_count(collection: str, filter_: dict) -> int:
    """Count rows matching `filter_` using a Directus aggregate query."""
    rows = await directus_async.async_directus.get_items(
        collection,
        {"query": {"filter": filter_, "aggregate": {"count": "id"}}},
    )
    if isinstance(rows, list) and rows:
        return int(rows[0].get("count", {}).get("id", 0) or 0)
    return 0


async def _oldest_id(collection: str, filter_: dict, date_field: str) -> Optional[str]:
    """Return the id of the oldest non-deleted row (earliest date_field)."""
    rows = await directus_async.async_directus.get_items(
        collection,
        {
            "query": {
                "filter": filter_,
                "fields": ["id"],
                "sort": [date_field],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0].get("id")
    return None


async def _workspace_project_ids(workspace_id: Optional[str]) -> list[str]:
    if not workspace_id:
        return []
    rows = await directus_async.async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {"workspace_id": {"_eq": workspace_id}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [r["id"] for r in rows if r.get("id")]


async def _resolve_project_ids(
    workspace_id: Optional[str], project_ids: Optional[list[str]]
) -> list[str]:
    """Use the caller's already-fetched project ids when provided (the usage
    endpoint passes its list to avoid refetching once per helper), else fetch."""
    if project_ids is not None:
        return project_ids
    return await _workspace_project_ids(workspace_id)


async def resolve_workspace_unlocked_conversation_id(
    workspace_id: Optional[str], project_ids: Optional[list[str]] = None
) -> Optional[str]:
    """The single conversation a free workspace keeps unlocked: the oldest
    non-deleted conversation across the workspace's projects."""
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return None
    return await _oldest_id(
        "conversation",
        {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
        "created_at",
    )


async def count_workspace_chats(workspace_id: Optional[str], project_ids: Optional[list[str]] = None) -> int:
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return 0
    return await _agg_count(
        "project_chat",
        {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
    )


async def resolve_workspace_primary_chat_id(
    workspace_id: Optional[str], project_ids: Optional[list[str]] = None
) -> Optional[str]:
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return None
    return await _oldest_id(
        "project_chat",
        {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
        "date_created",
    )


async def count_chat_user_turns(chat_id: str) -> int:
    """Count user messages in a chat. Both legacy and agentic chats persist
    user messages to project_chat_message (agentic via _persist_chat_user_message),
    so one count covers both."""
    return await _agg_count(
        "project_chat_message",
        {"project_chat_id": {"_eq": chat_id}, "message_from": {"_eq": "user"}},
    )


async def count_workspace_reports(
    workspace_id: Optional[str], project_ids: Optional[list[str]] = None
) -> int:
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return 0
    return await _agg_count(
        "project_report",
        {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
    )


async def resolve_workspace_primary_report_id(
    workspace_id: Optional[str], project_ids: Optional[list[str]] = None
) -> Optional[str]:
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return None
    return await _oldest_id(
        "project_report",
        {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
        "date_created",
    )


async def count_org_workspaces(org_id: str) -> int:
    return await _agg_count(
        "workspace",
        {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
    )


def build_free_tier_usage_block(
    *,
    tier: Optional[str],
    unlocked_conversation_id: Optional[str],
    chats_used: int,
    primary_chat_id: Optional[str],
    reports_used: int,
    primary_report_id: Optional[str],
) -> dict:
    """The `free_tier` block surfaced on the workspace usage payload. The
    frontend reads this instead of recomputing counts per component."""
    return {
        "active": is_free_tier(tier),
        "unlocked_conversation_id": unlocked_conversation_id,
        "chats_used": chats_used,
        "chats_limit": FREE_TIER_MAX_CHATS,
        "primary_chat_id": primary_chat_id,
        "reports_used": reports_used,
        "reports_limit": FREE_TIER_MAX_REPORTS,
        "primary_report_id": primary_report_id,
    }


async def resolve_project_tier(project_id: str) -> Optional[str]:
    """Resolve a project's tier through its workspace's billing account.
    Returns None when the project, its workspace, or the account is missing."""
    if not project_id:
        return None
    from dembrane.billing_account import resolve_workspace_tier

    project = await directus_async.async_directus.get_item("project", project_id)
    workspace_id = (project or {}).get("workspace_id")
    if not workspace_id:
        return None
    return await resolve_workspace_tier(workspace_id)


async def resolve_project_unlocked_conversation_id(project_id: str) -> Optional[str]:
    """The workspace's single unlocked conversation, resolved from a project id
    (project -> workspace -> oldest conversation). None when the chain breaks."""
    if not project_id:
        return None
    project = await directus_async.async_directus.get_item("project", project_id)
    workspace_id = (project or {}).get("workspace_id")
    if not workspace_id:
        return None
    return await resolve_workspace_unlocked_conversation_id(workspace_id)


def conversation_is_locked(
    conv: dict, tier: Optional[str], free_tier_unlocked_id: Optional[str] = None
) -> bool:
    """Whether a conversation is gated: the hours cap (over-cap on a
    non-overage tier) OR the free-tier rule (every conversation except the
    workspace's single unlocked one). Shared by the conversations BFF and the
    chat context-add paths so they cannot diverge."""
    if is_conversation_locked(conv, tier):
        return True
    return (
        is_free_tier(tier)
        and free_tier_unlocked_id is not None
        and conv.get("id") != free_tier_unlocked_id
    )
