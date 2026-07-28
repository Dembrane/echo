"""Free-tier gating: limit constants, the 402 contract, and the workspace /
org scoped counters and resolvers shared by the count-based free-tier gates
(chat, reports, workspaces).

Transcript visibility is NOT a count gate: free workspaces see transcripts up to
the 1-hour recording cap (the over-cap machinery in dembrane.tier_capacity), not
a fixed number of conversations. conversation_is_locked therefore delegates
straight to the hours cap.

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

# Per-workspace limits (chats, reports) and the per-chat turn limit. Workspaces
# are limited per org. Transcripts are gated by the 1-hour recording cap, not a
# conversation count. Named so product can tune them in one place.
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


async def _live_chat_ids(project_ids: list[str]) -> list[str]:
    """Ids of non-deleted chats across the given projects."""
    rows = await directus_async.async_directus.get_items(
        "project_chat",
        {
            "query": {
                "filter": {"project_id": {"_in": project_ids}, "deleted_at": {"_null": True}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [r["id"] for r in rows if r.get("id")]


async def count_workspace_chats(workspace_id: Optional[str], project_ids: Optional[list[str]] = None) -> int:
    """Count chats that consume the free-tier allowance: chats with at least one
    user message. An empty chat (a mode was picked but nothing was ever sent)
    does not count, so opening the composer and leaving never locks a free
    workspace out of starting a chat."""
    project_ids = await _resolve_project_ids(workspace_id, project_ids)
    if not project_ids:
        return 0
    chat_ids = await _live_chat_ids(project_ids)
    if not chat_ids:
        return 0
    rows = await directus_async.async_directus.get_items(
        "project_chat_message",
        {
            "query": {
                "filter": {
                    "project_chat_id": {"_in": chat_ids},
                    "message_from": {"_eq": "user"},
                },
                "aggregate": {"countDistinct": ["project_chat_id"]},
            }
        },
    )
    if isinstance(rows, list) and rows:
        return int((rows[0].get("countDistinct") or {}).get("project_chat_id", 0) or 0)
    return 0


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


async def count_org_workspaces(
    org_id: str, billing_account_id: Optional[str] = None
) -> int:
    """Count an org's non-deleted workspaces. When `billing_account_id` is
    given, count only workspaces that bill to that (org-pooled) account, so
    separately-billed client workspaces (which carry their own
    workspace-scoped account) don't consume the org's free-tier allowance."""
    filter_: dict = {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}}
    if billing_account_id is not None:
        filter_["billing_account_id"] = {"_eq": billing_account_id}
    return await _agg_count("workspace", filter_)


def build_free_tier_usage_block(
    *,
    tier: Optional[str],
    chats_used: int,
    primary_chat_id: Optional[str],
    reports_used: int,
    primary_report_id: Optional[str],
) -> dict:
    """The `free_tier` block surfaced on the workspace usage payload. The
    frontend reads this instead of recomputing counts per component."""
    return {
        "active": is_free_tier(tier),
        "chats_used": chats_used,
        "chats_limit": FREE_TIER_MAX_CHATS,
        "primary_chat_id": primary_chat_id,
        "reports_used": reports_used,
        "reports_limit": FREE_TIER_MAX_REPORTS,
        "primary_report_id": primary_report_id,
    }


async def _resolve_project_workspace_and_tier(
    project_id: str,
) -> tuple[Optional[str], Optional[str]]:
    """Resolve (workspace_id, tier) for a project in one project read.
    Returns (None, None) when the project or workspace is missing."""
    if not project_id:
        return None, None
    from dembrane.billing_account import resolve_workspace_tier

    project = await directus_async.async_directus.get_item("project", project_id)
    workspace_id = (project or {}).get("workspace_id")
    if not workspace_id:
        return None, None
    return workspace_id, await resolve_workspace_tier(workspace_id)


async def resolve_project_tier(project_id: str) -> Optional[str]:
    """Resolve a project's tier through its workspace's billing account.
    Returns None when the project, its workspace, or the account is missing."""
    _, tier = await _resolve_project_workspace_and_tier(project_id)
    return tier


# Short TTL: the answer changes slowly and a few seconds of lag on a content gate
# is harmless.
_OVER_CAP_ACTIVE_TTL_SECONDS = 60


def _over_cap_active_cache_key(workspace_id: str) -> str:
    return f"overcap:active:{workspace_id}"


async def _workspace_lifetime_audio_hours(workspace_id: str) -> float:
    """Sum of every conversation's duration in the workspace, in hours.
    Includes soft-deleted rows (PRD §270: delete preserves billable duration)."""
    project_ids = await _workspace_project_ids(workspace_id)
    if not project_ids:
        return 0.0
    rows = await directus_async.async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"project_id": {"_in": project_ids}},
                "fields": ["duration"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return 0.0
    return sum(r.get("duration") or 0 for r in rows) / 3600


async def workspace_over_cap_active(
    workspace_id: Optional[str], tier: Optional[str]
) -> bool:
    """Whether the workspace is past its lifetime hour cap right now (Free's
    1-hour cap). A live signal, unlike the finish-time `is_over_cap` stamp, so it
    also gates conversations still recording. Paid/legacy tiers never cap."""
    from dembrane.tier_capacity import get_capacity, tier_allows_overage

    if not workspace_id or tier is None or tier_allows_overage(tier):
        return False
    cap = get_capacity(tier)
    if cap is None or cap.included_hours is None:
        return False

    from dembrane.cache_utils import cache_get_json, cache_set_json

    key = _over_cap_active_cache_key(workspace_id)
    cached = await cache_get_json(key)
    if isinstance(cached, bool):
        return cached

    active = await _workspace_lifetime_audio_hours(workspace_id) >= cap.included_hours
    await cache_set_json(key, active, _OVER_CAP_ACTIVE_TTL_SECONDS)
    return active


async def resolve_project_gate(project_id: str) -> tuple[Optional[str], bool]:
    """Resolve (tier, over_cap_active) for a project in one project read, for
    callers that need both and haven't resolved the tier yet (the monitor)."""
    workspace_id, tier = await _resolve_project_workspace_and_tier(project_id)
    if not workspace_id:
        return None, False
    return tier, await workspace_over_cap_active(workspace_id, tier)


def conversation_is_locked(conv: dict, tier: Optional[str]) -> bool:
    """Whether a conversation is gated: over-cap on an hour-capped tier (Free's
    1-hour recording cap). Thin wrapper over the hours-cap predicate so the
    conversations BFF, the summarize/title gates, and the chat context-add paths
    share one lock decision and cannot diverge."""
    return is_conversation_locked(conv, tier)
