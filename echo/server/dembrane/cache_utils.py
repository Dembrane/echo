"""Lightweight JSON cache helpers around the async Redis client.

Used for:
- Workspace usage rollups (30-min TTL). Re-computing hours means summing
  conversation.duration across a workspace's projects, which is O(N) in
  conversations — cacheable for minutes without stale-data concerns
  because "current calendar month hours" is the whole point.

Caller conventions:
- Cache keys include a namespace prefix ("usage:", "capacity:", ...) so
  flushes are targeted.
- Reads return None on miss or on any error (never raise) — the caller
  treats Redis-down as a cache miss, never as an endpoint failure.
- Writes are fire-and-forget best-effort. Redis-down means the next
  request recomputes.
"""

from __future__ import annotations

import json
from typing import Any, Optional
from logging import getLogger

from dembrane.redis_async import get_redis_client

logger = getLogger("dembrane.cache_utils")


async def cache_get_json(key: str) -> Optional[Any]:
    """Return the JSON-decoded value at `key`, or None on miss/error."""
    try:
        client = await get_redis_client()
        raw = await client.get(key)
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)
    except Exception as exc:
        logger.debug("cache_get_json miss/error key=%s err=%s", key, exc)
        return None


async def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    """Write JSON-encoded `value` at `key` with TTL. Best-effort."""
    try:
        client = await get_redis_client()
        payload = json.dumps(value, default=str)
        await client.setex(key, ttl_seconds, payload)
    except Exception as exc:
        logger.debug("cache_set_json error key=%s err=%s", key, exc)


async def cache_delete(key: str) -> None:
    """Delete a single cache key. Best-effort."""
    try:
        client = await get_redis_client()
        await client.delete(key)
    except Exception as exc:
        logger.debug("cache_delete error key=%s err=%s", key, exc)


# ── Namespaced helpers ─────────────────────────────────────────────────


USAGE_TTL_SECONDS = 30 * 60  # 30 minutes


def usage_cache_key(workspace_id: str) -> str:
    return f"usage:{workspace_id}"


def org_usage_cache_key(org_id: str) -> str:
    return f"org_usage:{org_id}"


async def invalidate_workspace_usage(workspace_id: str) -> None:
    """Bust the cached usage rollup for a workspace. Call on tier changes
    (upgrade/downgrade) so the next /usage read reflects new caps + rates
    immediately instead of waiting for TTL expiry."""
    await cache_delete(usage_cache_key(workspace_id))


async def invalidate_org_usage(org_id: str) -> None:
    """Bust the cached organisation-wide rollup. Call alongside
    invalidate_workspace_usage on tier changes since the aggregate
    depends on per-workspace caps."""
    await cache_delete(org_usage_cache_key(org_id))


async def invalidate_workspace_and_org_usage(workspace_id: str, org_id: Optional[str]) -> None:
    """Bust both the workspace-scope and org-scope usage caches.

    Call from any path that mutates `workspace_membership` (invite accept,
    role change, remove, access-request approve). Org-scope cache aggregates
    over every workspace in the org, so a single seat / guest change must
    invalidate both layers — otherwise org-level guest counts go stale for
    up to USAGE_TTL_SECONDS after the workspace-level count refreshes.
    """
    await invalidate_workspace_usage(workspace_id)
    if org_id:
        await invalidate_org_usage(org_id)
